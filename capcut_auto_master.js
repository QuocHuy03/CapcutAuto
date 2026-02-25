'use strict';
/**
 * capcut_auto_master.js
 *
 * File “tổng hợp” để AI / script khác dễ xài:
 *   1. Đồng bộ ảnh/video với audio (giống capcut_update_project nhưng tách hàm rõ ràng)
 *   2. Áp animation cho mỗi ảnh/video
 *   3. Áp LIST video_effect từ effect_catalog.json hoặc từ tham số CLI
 *   4. (Khung) Keyframe – chừa cấu trúc/hook rõ ràng để bạn / AI khác cài thêm
 *
 * Ý tưởng: coi file này như 1 “API thuần JS” cho CapCut project, mỗi bước là 1 hàm:
 *   - loadProject()      → đọc draft_content.json
 *   - syncMediaToAudio() → đồng bộ thời gian
 *   - applyAnimations()  → thêm animation in
 *   - applyEffectsList() → thêm list video_effect
 *   - applyKeyframes()   → (chưa implement đầy đủ, có khung & comment)
 *   - saveProject()      → ghi lại draft_content.json + Timelines/*
 *
 * Usage (ví dụ):
 *   node capcut_auto_master.js ^
 *     --project "C:\\...\\com.lveditor.draft\\0224" ^
 *     --sync ^
 *     --anim 6798332733694153230 ^
 *     --animdur 500 ^
 *     --effects 7463081288182828341,7463081288182828342 ^
 *     --dry
 *
 * Ghi chú:
 *   - ĐÓNG CapCut trước khi chạy.
 *   - Nếu bạn muốn điều khiển phức tạp hơn (per segment, timeline, keyframes chi tiết),
 *     hãy sửa/extend các hàm phía dưới, giữ nguyên interface cho dễ hiểu.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
}

// Project / options mặc định (giữ giống file cũ để tiện reuse)
const projectDir = args.project ||
  'C:\\Users\\LYN HIEN\\AppData\\Local\\CapCut\\User Data\\Projects\\com.lveditor.draft\\0224';

// Đồng bộ
const doSync = args.nosync ? false : true;

// Animation (transition in cho ảnh/video)
const animId = args.anim || '6798332733694153230'; // Zoom In (ví dụ)
const animDurMs = parseInt(args.animdur || '500', 10);
const doAnim = args.noanim ? false : true;

// LIST video_effect: "--effects id1,id2,id3" (áp lần lượt, tất cả cùng tồn tại)
const effectsListRaw = (args.effects || '').trim();
const effectIds = effectsListRaw
  ? effectsListRaw.split(',').map(s => s.trim()).filter(Boolean)
  : [];
const doEffectsList = effectIds.length > 0 && !args.noeffect;

// Keyframe (chưa implement, nhưng có hook & config file)
// Ví dụ: --keyframe-config my_keyframes.json
const keyframeConfigPath = args['keyframe-config'] || args.keyframes || '';
const doKeyframes = !!keyframeConfigPath && !args.nokeyframe;

// Chế độ dry-run
const dryRun = !!args.dry;

// ── Helpers chung ─────────────────────────────────────────────────────────────
function uuid() {
  // Dùng kiểu giống capcut_update_project (UPPERCASE) để đồng nhất
  return crypto.randomUUID().toUpperCase();
}

function toFwd(p) {
  return p.replace(/\\/g, '/');
}

function loadJsonSafe(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function loadEffectCatalog() {
  const catFile = path.join(__dirname, 'effect_catalog.json');
  if (!fs.existsSync(catFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(catFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Tìm thông tin effect (dùng chung cho animation & video_effect):
 *   - Ưu tiên tra trong effect_catalog.json (scan_effects.js đã build)
 *   - Fallback: quét Cache/effect/<id> giống capcut_update_project
 */
function resolveEffectInfo(effectId) {
  const cat = loadEffectCatalog();
  if (cat) {
    const found = cat.find(e => e.id === effectId);
    if (found) {
      return {
        path: toFwd(found.path),
        name: found.name || '',
        type: found.type || ''
      };
    }
  }

  // Fallback: quét trực tiếp thư mục Cache/effect/<id>
  // Cố gắng suy ra base từ projectDir nếu có dạng ...\User Data\Projects\...
  let effectBase = 'C:\\Users\\LYN HIEN\\AppData\\Local\\CapCut\\User Data\\Cache\\effect';
  const m = projectDir.match(/^(.*?\\AppData\\Local\\CapCut\\User Data)\\Projects\\/i);
  if (m) {
    effectBase = path.join(m[1], 'Cache', 'effect');
  }

  const ep = path.join(effectBase, effectId);
  if (fs.existsSync(ep)) {
    const hashes = fs.readdirSync(ep).filter(n => !n.endsWith('_tmp'));
    if (hashes.length > 0) {
      const p = toFwd(path.join(ep, hashes[0]));
      return { path: p, name: '', type: '' };
    }
  }
  return { path: '', name: '', type: '' };
}

// ── Core API “Capcut Project Pipeline” ────────────────────────────────────────

/**
 * Đọc draft_content.json chính + chuẩn bị đường dẫn Timelines.
 */
function loadProject(projectDir) {
  const draftPath = path.join(projectDir, 'draft_content.json');
  const timelinesDir = path.join(projectDir, 'Timelines');

  if (!fs.existsSync(draftPath)) {
    throw new Error('Không tìm thấy draft_content.json ở ' + draftPath);
  }

  // Backup 1 file để an toàn
  const backupPath = draftPath + '.bak_auto_master';
  fs.copyFileSync(draftPath, backupPath);

  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  return { draft, draftPath, timelinesDir, backupPath };
}

/**
 * Đồng bộ thời gian ảnh/video theo tổng audio:
 *   - Chia đều duration audio cho tất cả segment video trong track "video"
 *   - Cập nhật lại source_timerange / target_timerange
 *   - Cập nhật audio segments để phát nối tiếp nhau
 *   - Cập nhật draft.duration = tổng audio
 */
function syncMediaToAudio(draft) {
  const videoTrack = (draft.tracks || []).find(t => t.type === 'video');
  const audioTrack = (draft.tracks || []).find(t => t.type === 'audio');
  if (!videoTrack) throw new Error('Không có video track trong draft_content.json');

  const videoSegs = videoTrack.segments || [];
  const audioSegs = audioTrack ? (audioTrack.segments || []) : [];

  if (videoSegs.length === 0) {
    console.warn('⚠️  Không có video segments để sync.');
    return;
  }

  // Tổng duration audio (ưu tiên segments, fallback materials.audios)
  let totalAudioDurationUs = 0;
  if (audioSegs.length > 0) {
    totalAudioDurationUs = audioSegs.reduce((sum, s) => {
      const dur = s.target_timerange && s.target_timerange.duration;
      return sum + (dur || 0);
    }, 0);
  } else if (draft.materials && draft.materials.audios) {
    totalAudioDurationUs = draft.materials.audios.reduce((sum, a) => sum + (a.duration || 0), 0);
  }

  if (!totalAudioDurationUs) {
    throw new Error('Không tìm được tổng duration audio (segments/materials.audios).');
  }

  const imgDurationUs = Math.round(totalAudioDurationUs / videoSegs.length);
  let timeOffset = 0;

  for (const seg of videoSegs) {
    if (!seg.source_timerange) seg.source_timerange = { start: 0, duration: imgDurationUs };
    if (!seg.target_timerange) seg.target_timerange = { start: 0, duration: imgDurationUs };

    seg.source_timerange.start = 0;
    seg.source_timerange.duration = imgDurationUs;
    seg.target_timerange.start = timeOffset;
    seg.target_timerange.duration = imgDurationUs;

    timeOffset += imgDurationUs;
  }

  // Cập nhật video_algorithm.time_range cho mỗi video material
  const animDurUs = animDurMs * 1000;
  const videos = (draft.materials && draft.materials.videos) || [];
  for (const seg of videoSegs) {
    const vid = videos.find(v => v.id === seg.material_id);
    if (vid && vid.video_algorithm) {
      vid.video_algorithm.time_range = {
        duration: imgDurationUs + animDurUs,
        start: 0
      };
    }
  }

  // Cập nhật audio segments nối tiếp nhau
  let audioOffset = 0;
  for (const seg of audioSegs) {
    if (!seg.source_timerange || !seg.target_timerange) continue;
    seg.source_timerange.start = 0;
    seg.target_timerange.start = audioOffset;
    audioOffset += seg.target_timerange.duration || 0;
  }

  draft.duration = totalAudioDurationUs;

  console.log(`   ✅ SYNC: ${videoSegs.length} ảnh/video, mỗi segment ~ ${(imgDurationUs / 1e6).toFixed(2)}s`);
  console.log(`   ✅ Project duration: ${(draft.duration / 1e6).toFixed(2)}s`);
}

/**
 * Thêm animation "in" cho mỗi video segment.
 *   - Dùng materials.material_animations (giống capcut_update_project)
 *   - Nếu segment đã có animation thì update; nếu chưa thì tạo mới.
 */
function applyAnimations(draft, animId, animDurMs) {
  const tracks = draft.tracks || [];
  const videoTrack = tracks.find(t => t.type === 'video');
  if (!videoTrack) {
    console.warn('⚠️  Không có video track để add animation.');
    return;
  }

  const videoSegs = videoTrack.segments || [];
  if (videoSegs.length === 0) {
    console.warn('⚠️  Video track không có segments.');
    return;
  }

  if (!draft.materials) draft.materials = {};
  if (!draft.materials.material_animations) draft.materials.material_animations = [];

  const animDurUs = animDurMs * 1000;
  const info = resolveEffectInfo(animId);

  if (!info.path) {
    console.warn('⚠️  Không tìm thấy effect path cho animation id=' + animId);
    console.warn('   Gợi ý: chạy "node scan_effects.js" để rebuild effect_catalog.json');
  }

  for (const seg of videoSegs) {
    if (!seg.extra_material_refs) seg.extra_material_refs = [];

    // Tìm material_animation hiện có
    let animMatId = null;
    for (const refId of seg.extra_material_refs) {
      const existing = draft.materials.material_animations.find(ma => ma.id === refId);
      if (existing) { animMatId = refId; break; }
    }

    // Nếu chưa có → tạo mới & insert vào index 3 (sau speed, placeholder, canvas)
    if (!animMatId) {
      animMatId = uuid();
      const insertAt = Math.min(3, seg.extra_material_refs.length);
      seg.extra_material_refs.splice(insertAt, 0, animMatId);
    }

    // Upsert material_animation
    let animMat = draft.materials.material_animations.find(ma => ma.id === animMatId);
    if (!animMat) {
      animMat = {
        id: animMatId,
        animations: [],
        multi_language_current: 'none',
        type: 'sticker_animation'
      };
      draft.materials.material_animations.push(animMat);
    }

    const existingAnim = animMat.animations.find(a => a.type === 'in');
    const animEntry = {
      anim_adjust_params: null,
      category_id: '6824',
      category_name: '',
      duration: animDurUs,
      id: animId,
      material_type: 'video',
      name: info.name || 'Zoom In',
      panel: 'video',
      path: info.path || '',
      platform: 'all',
      request_id: '',
      resource_id: animId,
      source_platform: 1,
      start: 0,
      third_resource_id: animId,
      type: 'in'
    };

    if (existingAnim) {
      Object.assign(existingAnim, animEntry);
    } else {
      animMat.animations.push(animEntry);
    }
  }

  console.log(`   ✨ Animation: id=${animId}, duration=${animDurMs}ms → ${videoSegs.length} segments`);
}

/**
 * Áp LIST video_effect cho từng video segment.
 *
 * Cách đơn giản (dễ hiểu):
 *   - Với mỗi segment:
 *       + Tạo / reuse 1 material video_effect cho từng effectId
 *       + Push id đó vào extra_material_refs của segment
 *   - 1 segment có thể có nhiều video_effect (đặt cạnh nhau trong extra_material_refs)
 *
 * patterns:
 *   - effectIds = ['id1', 'id2', ...] → tất cả áp vào mọi segment
 *   - Nếu bạn muốn logic phức tạp (theo index, theo thời gian...) → sửa logic bên trong hàm.
 */
function applyEffectsList(draft, effectIds) {
  if (!effectIds || effectIds.length === 0) {
    console.log('⏭  Không có effectIds (LIST video_effect trống).');
    return;
  }

  const tracks = draft.tracks || [];
  const videoTrack = tracks.find(t => t.type === 'video');
  if (!videoTrack) {
    console.warn('⚠️  Không có video track để add video_effect.');
    return;
  }

  const videoSegs = videoTrack.segments || [];
  if (videoSegs.length === 0) {
    console.warn('⚠️  Video track không có segments.');
    return;
  }

  if (!draft.materials) draft.materials = {};
  if (!draft.materials.video_effects) draft.materials.video_effects = [];

  // Template: nếu đã có sẵn ít nhất 1 video_effect thì dùng làm “mẫu”
  const template = draft.materials.video_effects[0] || null;

  for (const seg of videoSegs) {
    if (!seg.extra_material_refs) seg.extra_material_refs = [];

    // Ta không cố reuse theo id cũ để tránh rối – cứ tạo mới cho rõ.
    for (const effId of effectIds) {
      const info = resolveEffectInfo(effId);

      const vfxMatId = uuid();
      // Chèn hơi sớm trong extra_material_refs để CapCut render đúng layer
      const insertAt = Math.min(2, seg.extra_material_refs.length);
      seg.extra_material_refs.splice(insertAt, 0, vfxMatId);

      let vfxMat;
      if (template) {
        vfxMat = JSON.parse(JSON.stringify(template));
      } else {
        vfxMat = {
          adjust_params: [],
          algorithm_artifact_path: '',
          apply_target_type: 0,
          apply_time_range: null,
          bind_segment_id: '',
          category_id: '',
          category_name: '',
          common_keyframes: [],
          covering_relation_change: 0,
          disable_effect_faces: [],
          effect_id: effId,
          effect_mask: [],
          enable_mask: true,
          enable_video_mask_shadow: true,
          enable_video_mask_stroke: true,
          formula_id: '',
          id: vfxMatId,
          item_effect_type: 0,
          name: info.name || '',
          path: info.path || '',
          platform: 'all',
          render_index: 11000,
          request_id: '',
          resource_id: effId,
          source_platform: 1,
          sub_type: 0,
          time_range: null,
          track_render_index: 0,
          transparent_params: '',
          type: 'video_effect',
          value: 1.0,
          version: ''
        };
      }

      // Gắn các field quan trọng theo effect hiện tại
      vfxMat.id = vfxMatId;
      vfxMat.effect_id = effId;
      vfxMat.resource_id = effId;
      if (info.path) vfxMat.path = info.path;
      if (info.name) vfxMat.name = info.name;

      draft.materials.video_effects.push(vfxMat);
    }
  }

  console.log(`   🎬 Video effects list: [${effectIds.join(', ')}]`);
  console.log(`   🎬 Đã áp cho ${videoSegs.length} segments (mỗi segment ${effectIds.length} effect).`);
}

/**
 * Khung xử lý Keyframe:
 *
 * Vì trong repo hiện tại chưa có ví dụ JSON với common_keyframes/keyframe_refs đầy đủ,
 * hàm này chỉ:
 *   - Đọc file config (nếu có)
 *   - Log ra hướng dẫn + TODO rất rõ để AI khác / bạn ghi tiếp dựa trên stage_check
 *
 * Đề xuất format file keyframe-config (ví dụ keyframes_demo.json):
 * {
 *   "per_segment": "all",         // "all" | "even" | "odd" | [list segment id]
 *   "property": "clip.scale.x",   // Thuộc tính bạn muốn keyframe (ví dụ: scale, rotation...)
 *   "points": [
 *     { "t": 0.0, "value": 1.0 },
 *     { "t": 0.5, "value": 1.1 },
 *     { "t": 1.0, "value": 1.0 }
 *   ]
 * }
 *
 * Sau đó dùng capcut_stage_check.js để:
 *   - Record thao tác tạo 1–2 keyframe trong CapCut
 *   - So sánh diff → copy cấu trúc common_keyframes / keyframe_refs vào đây
 *   - Map từ "property" + "points" (config đơn giản) sang JSON thật sự của CapCut.
 */
function applyKeyframes(draft, projectDir, keyframeConfigPath) {
  console.log('\n── KEYFRAME PIPELINE (KHUNG / TODO) ──');

  if (!keyframeConfigPath) {
    console.log('⏭  Không có --keyframe-config / --keyframes → bỏ qua.');
    return;
  }

  const abs = path.isAbsolute(keyframeConfigPath)
    ? keyframeConfigPath
    : path.join(process.cwd(), keyframeConfigPath);

  const cfg = loadJsonSafe(abs);
  if (!cfg) {
    console.log('⚠️  Không đọc được file keyframe-config:', abs);
    return;
  }

  console.log('📄 Đã load keyframe-config từ:', abs);
  console.log('    (Chi tiết cấu trúc xem trực tiếp trong file JSON).');

  // TODO: Đây là nơi bạn/AI khác map cfg → draft.common_keyframes / keyframe_refs.
  // Ví dụ pseudo-code (KHÔNG chạy, chỉ minh họa):
  //
  //   const videoTrack = draft.tracks.find(t => t.type === 'video');
  //   for (const seg of videoTrack.segments) {
  //     if (!seg.common_keyframes) seg.common_keyframes = [];
  //     // push keyframe objects, rồi cập nhật seg.keyframe_refs nếu cần
  //   }
  //
  // Thực tế:
  //   1. Mở 1 project test trong CapCut, tạo 2–3 keyframe (scale/position).
  //   2. Dùng capcut_stage_check.js để xem diff draft_content.json.
  //   3. Copy các object JSON keyframe tương ứng vào 1 file ghi chú.
  //   4. Implement chuyển đổi từ cfg.points → JSON thật (thêm id, time, value...).

  console.log('💡 HINT: Dùng "node capcut_stage_check.js" để reverse-engineer cấu trúc keyframes,\n' +
              '    sau đó implement logic trong hàm applyKeyframes().');
}

/**
 * Ghi draft_content.json + tất cả Timelines/<id>/draft_content.json
 */
function saveProject(draft, draftPath, timelinesDir) {
  const outJson = JSON.stringify(draft);

  if (dryRun) {
    console.log('\n🔍 DRY RUN (KHÔNG GHI FILE) — bạn có thể sửa tiếp logic rồi chạy lại.');
    console.log('   Project duration:', draft.duration, 'µs ≈', (draft.duration / 1e6).toFixed(2), 's');
    return;
  }

  // Ghi vào file chính
  fs.writeFileSync(draftPath, outJson);

  // Ghi vào tất cả Timelines/*
  if (fs.existsSync(timelinesDir)) {
    for (const tlId of fs.readdirSync(timelinesDir)) {
      const tlPath = path.join(timelinesDir, tlId, 'draft_content.json');
      if (fs.existsSync(tlPath)) {
        fs.writeFileSync(tlPath, outJson);
      }
    }
  }

  console.log('\n✅ ĐÃ LƯU PROJECT (draft_content.json + Timelines/*)');
}

// ── MAIN FLOW ─────────────────────────────────────────────────────────────────
(function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  CapCut Auto Master — All-in-one Pipeline');
  console.log('  Project:', projectDir);
  console.log('═'.repeat(60));

  let ctx;
  try {
    ctx = loadProject(projectDir);
  } catch (err) {
    console.error('❌ Lỗi load project:', err.message || err);
    process.exit(1);
  }

  const { draft, draftPath, timelinesDir, backupPath } = ctx;
  console.log('💾 Backup draft:', path.basename(backupPath));

  // 1) SYNC media ↔ audio
  if (doSync) {
    console.log('\n🔄 Bước 1: SYNC ảnh/video với audio...');
    try {
      syncMediaToAudio(draft);
    } catch (err) {
      console.error('❌ Lỗi SYNC:', err.message || err);
      process.exit(1);
    }
  } else {
    console.log('\n⏭ Bỏ qua SYNC (--nosync).');
  }

  // 2) ANIMATION
  if (doAnim) {
    console.log('\n✨ Bước 2: Animation cho từng segment...');
    try {
      applyAnimations(draft, animId, animDurMs);
    } catch (err) {
      console.error('❌ Lỗi Animation:', err.message || err);
      process.exit(1);
    }
  } else {
    console.log('\n⏭ Bỏ qua Animation (--noanim).');
  }

  // 3) LIST video_effect
  if (doEffectsList) {
    console.log('\n🎬 Bước 3: Áp LIST video_effect cho mỗi segment...');
    try {
      applyEffectsList(draft, effectIds);
    } catch (err) {
      console.error('❌ Lỗi Video Effects:', err.message || err);
      process.exit(1);
    }
  } else {
    console.log('\n⏭ Bỏ qua Video Effects list (không có --effects hoặc có --noeffect).');
  }

  // 4) KEYFRAMES (khung/hook)
  if (doKeyframes) {
    try {
      applyKeyframes(draft, projectDir, keyframeConfigPath);
    } catch (err) {
      console.error('❌ Lỗi Keyframes:', err.message || err);
      process.exit(1);
    }
  } else {
    console.log('\n⏭ Bỏ qua Keyframes (không có --keyframe-config hoặc có --nokeyframe).');
  }

  // 5) SAVE
  console.log('\n💾 Bước 5: Ghi lại project...');
  saveProject(draft, draftPath, timelinesDir);

  console.log('\n' + '═'.repeat(60));
  console.log('✅ DONE — CapCut Auto Master hoàn thành.');
  console.log('   Bạn có thể mở lại project trong CapCut để xem kết quả.');
  console.log('═'.repeat(60) + '\n');
})();

