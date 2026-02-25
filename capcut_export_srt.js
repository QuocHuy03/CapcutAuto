'use strict';
/**
 * capcut_export_srt.js
 * Đọc project CapCut đã chạy Auto Captions và export ra file .srt
 *
 * Usage:
 *   node capcut_export_srt.js --project "C:\...\com.lveditor.draft\0224" [--out subtitles.srt]
 *
 * Lưu ý:
 *   - Nên đóng CapCut trước khi chạy để tránh CapCut ghi đè song song.
 *   - Script ưu tiên lấy subtitles từ extra_info.subtitle_fragment_info_list
 *     (CapCut lưu dữ liệu Auto Caption ở đây).
 */

const fs = require('fs');
const path = require('path');

// ── Parse args ────────────────────────────────────────────────────────────────
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
  'C:\\Users\\LYN HIEN\\AppData\\Local\\CapCut\\User Data\\Projects\\com.lveditor.draft\\0224';
const outPath = args.out ? path.resolve(args.out) : path.join(projectDir, 'subtitles.srt');

// ── Helpers ──────────────────────────────────────────────────────────────────
function loadJsonSafe(fp) {
  try {
    const txt = fs.readFileSync(fp, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

function formatTimeFromUs(us) {
  if (!Number.isFinite(us)) us = 0;
  const totalMs = Math.round(us / 1000); // CapCut dùng µs → ms
  const ms = totalMs % 1000;
  const totalSec = (totalMs - ms) / 1000;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  const m = totalMin % 60;
  const h = (totalMin - m) / 60;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function pickFirst(obj, keys, def) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return def;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(function main() {
  console.log('\n' + '═'.repeat(55));
  console.log('  CapCut Export SRT');
  console.log('  Project:', projectDir);
  console.log('═'.repeat(55));

  const draftPathBak = path.join(projectDir, 'draft_content.json.bak');
  const draftPath = path.join(projectDir, 'draft_content.json');

  let draft = null;
  // Ưu tiên file hiện tại (CapCut vừa generate captions xong)
  if (fs.existsSync(draftPath)) {
    draft = loadJsonSafe(draftPath);
    console.log('📄 Dùng file:', path.basename(draftPath));
  }
  // Fallback sang bản .bak nếu cần
  if ((!draft || !draft.tracks || !draft.materials) && fs.existsSync(draftPathBak)) {
    draft = loadJsonSafe(draftPathBak);
    console.log('📄 Fallback file:', path.basename(draftPathBak));
  }
  if (!draft) {
    console.error('❌ Không đọc được draft_content.json(.bak)');
    process.exit(1);
  }

  // ── Cách 1: đọc phụ đề từ text track + materials.texts (ổn định hơn) ──
  const tracks = draft.tracks || [];
  const textTrack = tracks.find(t => t.type === 'text');
  const texts = (draft.materials && draft.materials.texts) || [];

  if (!textTrack || !Array.isArray(textTrack.segments) || textTrack.segments.length === 0 || texts.length === 0) {
    console.error('❌ Không tìm thấy text track / materials.texts trong project (có chắc đã Generate captions chưa?)');
    process.exit(1);
  }

  console.log('📊 Text segments:', textTrack.segments.length, ' | Text materials:', texts.length);

  const textById = {};
  for (const t of texts) {
    let plain = (t.recognize_text || '').trim();
    if (!plain && t.base_content) {
      try {
        const bc = JSON.parse(t.base_content);
        if (bc && typeof bc.text === 'string') plain = bc.text.trim();
      } catch { /* ignore */ }
    }
    textById[t.id] = {
      text: plain,
      language: (t.language || '').toLowerCase()
    };
  }

  // Chuẩn hóa segments → { startUs, endUs, text }
  const norm = textTrack.segments.map((seg, idx) => {
    const startUs = pickFirst(seg.target_timerange || {}, ['start'], 0) ||
      pickFirst(seg.source_timerange || {}, ['start'], 0);
    const durUs = pickFirst(seg.target_timerange || {}, ['duration'], 0) ||
      pickFirst(seg.source_timerange || {}, ['duration'], 0);
    const endUs = startUs + durUs;

    const info = textById[seg.material_id] || { text: '', language: '' };
    const txt = String(info.text || '').replace(/\r?\n/g, ' ').trim();
    const lang = info.language || '';

    return { index: idx + 1, startUs, endUs, text: txt, language: lang };
  }).filter(f => f.text);

  if (norm.length === 0) {
    console.error('❌ Không tìm được text từ text track / materials.texts');
    process.exit(1);
  }

  norm.sort((a, b) => a.startUs - b.startUs);

  // Nhóm theo language (en-US, vi-VN, ...)
  const byLang = {};
  for (const item of norm) {
    const lang = item.language || 'unknown';
    if (!byLang[lang]) byLang[lang] = [];
    byLang[lang].push(item);
  }

  const langs = Object.keys(byLang);

  // Hàm ghi 1 file SRT từ 1 list entries
  function writeSrt(entries, targetPath) {
    const lines = [];
    entries.forEach((f, i) => {
      const start = formatTimeFromUs(f.startUs);
      const end = formatTimeFromUs(f.endUs);
      lines.push(String(i + 1));
      lines.push(`${start} --> ${end}`);
      lines.push(f.text || '');
      lines.push('');
    });
    fs.writeFileSync(targetPath, lines.join('\n'), 'utf8');
  }

  if (langs.length === 1 && args.out) {
    // Nếu chỉ có 1 ngôn ngữ và user chỉ định --out -> ghi gộp vào đúng file đó
    writeSrt(byLang[langs[0]], outPath);
    console.log('\n✅ Đã export SRT:');
    console.log('   ' + outPath + '\n');
  } else if (langs.length === 1) {
    // 1 ngôn ngữ, không chỉ định --out -> đặt tên subtitles_<langShort>.srt
    const short = (langs[0].split('-')[0] || 'unknown');
    const target = path.join(projectDir, `subtitles_${short}.srt`);
    writeSrt(byLang[langs[0]], target);
    console.log('\n✅ Đã export SRT:');
    console.log('   ' + target + '\n');
  } else {
    // Nhiều ngôn ngữ -> ghi mỗi lang 1 file subtitles_<langShort>.srt
    console.log('\n✅ Đã export multi-language SRT:');
    for (const lang of langs) {
      const short = (lang.split('-')[0] || 'unknown');
      const target = path.join(projectDir, `subtitles_${short}.srt`);
      writeSrt(byLang[lang], target);
      console.log('   ' + lang + ' → ' + target);
    }
    console.log('');
  }
})();

