'use strict';
/**
 * capcut_update_project.js
 * Chỉnh sửa project CapCut có sẵn (đã có ảnh + audio):
 *   1. Sync thời gian ảnh theo audio (chia đều hoặc theo từng audio)
 *   2. Thêm animation vào mỗi ảnh
 *
 * ĐÓNG CAPCUT trước khi chạy!
 *
 * Usage:
 *   node capcut_update_project.js [options]
 *
 * Options:
 *   --project <dir>   Thư mục project CapCut
 *                     (default: C:\Users\huylq\AppData\Local\CapCut\...\0225)
 *   --anim    <id>    Effect ID animation  (default: 6798332733694153230 = Zoom In)
 *   --animdur <ms>    Thời lượng animation (default: 500ms)
 *   --nosync          Không sync timing, chỉ thêm animation
 *   --noanim          Không thêm animation, chỉ sync timing
 *   --dry             Dry run: hiện thay đổi nhưng không ghi file
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Parse args ────────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
        const next = process.argv[i + 1];
        if (!next || next.startsWith('--')) args[a.slice(2)] = true;
        else { args[a.slice(2)] = next; i++; }
    }
}

const projectDir = args.project ||
    'C:\\Users\\huylq\\AppData\\Local\\CapCut\\User Data\\Projects\\com.lveditor.draft\\0225';
const animId = args.anim || '6798332733694153230';
const animDurMs = parseInt(args.animdur || '500', 10);
const doSync = !args.nosync;
const doAnim = !args.noanim;
const dryRun = !!args.dry;

// ── Helpers ───────────────────────────────────────────────────────────────
function uuid() { return crypto.randomUUID().toUpperCase(); }
function toFwd(p) { return p.replace(/\\/g, '/'); }

function resolveAnimPath(effectId) {
    const catFile = path.join(__dirname, 'effect_catalog.json');
    if (fs.existsSync(catFile)) {
        const cat = JSON.parse(fs.readFileSync(catFile, 'utf8'));
        const found = cat.find(e => e.id === effectId);
        if (found) return toFwd(found.path);
    }
    // Direct scan
    const effectBase = 'C:\\Users\\huylq\\AppData\\Local\\CapCut\\User Data\\Cache\\effect';
    const ep = path.join(effectBase, effectId);
    if (fs.existsSync(ep)) {
        const hashes = fs.readdirSync(ep).filter(n => !n.endsWith('_tmp'));
        if (hashes.length > 0) return toFwd(path.join(ep, hashes[0]));
    }
    return '';
}

// ── Load draft_content.json ───────────────────────────────────────────────
const draftPath = path.join(projectDir, 'draft_content.json');
const timelinesDir = path.join(projectDir, 'Timelines');

if (!fs.existsSync(draftPath)) {
    console.error('❌ Không tìm thấy:', draftPath);
    process.exit(1);
}

console.log('\n' + '═'.repeat(55));
console.log('  CapCut Update Project');
console.log('  Project:', projectDir);
console.log('═'.repeat(55));

// Backup
const backupPath = draftPath + '.bak_update';
fs.copyFileSync(draftPath, backupPath);
console.log('💾 Backup:', path.basename(backupPath));

const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));

// ── Identify tracks ───────────────────────────────────────────────────────
const videoTrack = draft.tracks.find(t => t.type === 'video');
const audioTrack = draft.tracks.find(t => t.type === 'audio');

if (!videoTrack) { console.error('❌ Không có video track!'); process.exit(1); }

const videoSegs = videoTrack.segments;
const audioSegs = audioTrack ? audioTrack.segments : [];

console.log(`\n📊 Tìm thấy:`);
console.log(`   Video segments (ảnh): ${videoSegs.length}`);
console.log(`   Audio segments:       ${audioSegs.length}`);

// ── Tính tổng duration audio ──────────────────────────────────────────────
let totalAudioDurationUs = 0;
if (audioSegs.length > 0) {
    // Tổng duration của tất cả audio segments
    totalAudioDurationUs = audioSegs.reduce((sum, s) => sum + s.target_timerange.duration, 0);
} else {
    // Lấy từ materials.audios
    const audios = draft.materials.audios || [];
    totalAudioDurationUs = audios.reduce((sum, a) => sum + (a.duration || 0), 0);
}

if (totalAudioDurationUs === 0) {
    console.error('❌ Không tìm được duration audio!');
    process.exit(1);
}

const totalAudioSec = (totalAudioDurationUs / 1e6).toFixed(2);
console.log(`   Audio total:          ${totalAudioSec}s  (${totalAudioDurationUs} µs)`);

// ── SYNC: cập nhật timing ảnh theo audio ─────────────────────────────────
if (doSync) {
    console.log('\n🔄 SYNC timing ảnh → audio...');

    // Phân chia: chia đều audio cho các ảnh
    const imgDurationUs = Math.round(totalAudioDurationUs / videoSegs.length);
    let timeOffset = 0;

    for (const seg of videoSegs) {
        const oldDur = seg.source_timerange.duration;
        const oldTgt = seg.target_timerange.duration;
        const oldStart = seg.target_timerange.start;

        seg.source_timerange.duration = imgDurationUs;
        seg.source_timerange.start = 0;
        seg.target_timerange.duration = imgDurationUs;
        seg.target_timerange.start = timeOffset;

        console.log(`   seg [${seg.id.slice(0, 8)}...]`);
        console.log(`     source dur: ${(oldDur / 1e6).toFixed(2)}s → ${(imgDurationUs / 1e6).toFixed(2)}s`);
        console.log(`     target: start=${(oldStart / 1e6).toFixed(2)}s→${(timeOffset / 1e6).toFixed(2)}s  dur=${(oldTgt / 1e6).toFixed(2)}s→${(imgDurationUs / 1e6).toFixed(2)}s`);

        timeOffset += imgDurationUs;
    }

    // Cập nhật video_algorithm.time_range cho mỗi video material
    const animDurUs = animDurMs * 1000;
    for (const seg of videoSegs) {
        const vid = draft.materials.videos.find(v => v.id === seg.material_id);
        if (vid && vid.video_algorithm) {
            vid.video_algorithm.time_range = {
                duration: imgDurationUs + animDurUs,
                start: 0
            };
        }
    }

    // Cập nhật audio segments timing (đặt lại start offset nếu nhiều audio)
    let audioOffset = 0;
    for (const seg of audioSegs) {
        seg.source_timerange.start = 0;
        seg.target_timerange.start = audioOffset;
        audioOffset += seg.target_timerange.duration;
    }

    // Cập nhật tổng duration project
    draft.duration = totalAudioDurationUs;

    console.log(`   ✅ Mỗi ảnh: ${(imgDurationUs / 1e6).toFixed(2)}s`);
} else {
    console.log('\n⏭ Bỏ qua sync timing (--nosync)');
}

// ── ANIMATION: thêm animation vào từng segment ──────────────────────────
if (doAnim) {
    console.log('\n✨ Thêm animation...');
    const animDurUs = animDurMs * 1000;
    const effectPath = resolveAnimPath(animId);

    if (!effectPath) {
        console.warn('⚠️  Không tìm thấy effect path cho id=' + animId);
        console.warn('   Chạy: node scan_effects.js để rebuild catalog');
    } else {
        console.log(`   Effect: ${animId}`);
        console.log(`   Path:   ${effectPath}`);
    }

    // Đảm bảo material_animations tồn tại
    if (!draft.materials.material_animations) {
        draft.materials.material_animations = [];
    }

    for (const seg of videoSegs) {
        // Tìm material_animation id trong extra_material_refs của segment
        // material_animation thường ở index 3 (sau speed, placeholder, canvas)
        let animMatId = null;

        // Tìm xem segment đã có ref đến material_animation nào chưa
        for (const refId of seg.extra_material_refs) {
            const existing = draft.materials.material_animations.find(ma => ma.id === refId);
            if (existing) { animMatId = refId; break; }
        }

        // Nếu chưa có → tạo mới và thêm ref vào segment
        if (!animMatId) {
            animMatId = uuid();
            // Chèn vào index 3 (sau speed[0], placeholder[1], canvas[2])
            const insertAt = Math.min(3, seg.extra_material_refs.length);
            seg.extra_material_refs.splice(insertAt, 0, animMatId);
            console.log(`   seg [${seg.id.slice(0, 8)}...] → tạo animMat mới: ${animMatId.slice(0, 8)}...`);
        } else {
            console.log(`   seg [${seg.id.slice(0, 8)}...] → cập nhật animMat: ${animMatId.slice(0, 8)}...`);
        }

        // Upsert material_animation object
        let animMat = draft.materials.material_animations.find(ma => ma.id === animMatId);
        if (!animMat) {
            animMat = { animations: [], id: animMatId, multi_language_current: 'none', type: 'sticker_animation' };
            draft.materials.material_animations.push(animMat);
        }

        // Upsert animation entry (type "in")
        const existingAnim = animMat.animations.find(a => a.type === 'in');
        const animEntry = {
            anim_adjust_params: null,
            category_id: '6824',
            category_name: '',
            duration: animDurUs,
            id: animId,
            material_type: 'video',
            name: 'Zoom In',
            panel: 'video',
            path: effectPath,
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

    console.log(`   ✅ Đã thêm animation vào ${videoSegs.length} segments`);
} else {
    console.log('\n⏭ Bỏ qua animation (--noanim)');
}

// ── Write ─────────────────────────────────────────────────────────────────
if (dryRun) {
    console.log('\n🔍 DRY RUN - Không ghi file');
    console.log('   duration sẽ là:', draft.duration, 'µs =', (draft.duration / 1e6).toFixed(2) + 's');
} else {
    const outJson = JSON.stringify(draft);

    // Ghi vào project root
    fs.writeFileSync(draftPath, outJson);

    // Ghi vào tất cả Timelines subdirs
    if (fs.existsSync(timelinesDir)) {
        for (const timelineId of fs.readdirSync(timelinesDir)) {
            const tlPath = path.join(timelinesDir, timelineId, 'draft_content.json');
            if (fs.existsSync(tlPath)) {
                fs.writeFileSync(tlPath, outJson);
            }
        }
    }

    console.log('\n✅ Đã lưu draft_content.json');
    console.log('   Mở CapCut → project sẽ hiện đúng timeline.\n');
}

console.log('═'.repeat(55) + '\n');
