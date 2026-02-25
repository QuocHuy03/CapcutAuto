'use strict';
/**
 * capcut_stage_check.js
 * Chụp TRƯỚC → bạn làm gì đó trong CapCut → Enter → chụp SAU → hiện diff chi tiết
 *
 * Usage:
 *   node capcut_stage_check.js [project_dir]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const projectDir = process.argv[2] ||
    'C:\\Users\\LYN HIEN\\AppData\\Local\\CapCut\\User Data\\Projects\\com.lveditor.draft\\0224';

// ── File scanning ──────────────────────────────────────────────────────────
function md5File(fp) {
    try { return crypto.createHash('md5').update(fs.readFileSync(fp)).digest('hex'); }
    catch { return null; }
}

function scanDir(dir, base = dir) {
    const result = {};
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            const rel = path.relative(base, full).replace(/\\/g, '/');
            if (e.isDirectory()) {
                result[rel] = { type: 'dir' };
                Object.assign(result, scanDir(full, base));
                continue;
            }
            const stat = fs.statSync(full);
            const entry = {
                type: 'file', size: stat.size, mtime: stat.mtimeMs,
                mtimeStr: stat.mtime.toISOString().replace('T', ' ').slice(0, 19),
                md5: md5File(full)
            };
            // Capture ALL json files including draft_content.json
            if (e.name.endsWith('.json') && stat.size < 5 * 1024 * 1024) {
                try { entry.content = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { }
            }
            result[rel] = entry;
        }
    } catch (err) { /* dir access error */ }
    return result;
}

// ── Deep diff helpers ──────────────────────────────────────────────────────
function fmtSize(b) { return b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`; }

// Collect all leaf paths from an object
function flatten(obj, prefix = '', out = {}) {
    if (obj === null || obj === undefined) { out[prefix] = obj; return out; }
    if (Array.isArray(obj)) {
        out[`${prefix}[len=${obj.length}]`] = '(array)';
        // Index items by id if available, otherwise by index
        obj.forEach((item, i) => {
            const key = (item && item.id) ? `${prefix}[id=${item.id}]` : `${prefix}[${i}]`;
            flatten(item, key, out);
        });
        return out;
    }
    if (typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
        return out;
    }
    out[prefix] = obj;
    return out;
}

// Compare two JSON objects, return structured diff
function deepDiff(a, b, path = '', changes = []) {
    if (a === b) return changes;
    const ta = Array.isArray(a) ? 'array' : typeof a;
    const tb = Array.isArray(b) ? 'array' : typeof b;

    // Both arrays
    if (ta === 'array' && tb === 'array') {
        if (JSON.stringify(a) === JSON.stringify(b)) return changes;
        // Try to match by id
        const aById = {}, bById = {};
        const aNoId = [], bNoId = [];
        a.forEach(item => (item && item.id) ? (aById[item.id] = item) : aNoId.push(item));
        b.forEach(item => (item && item.id) ? (bById[item.id] = item) : bNoId.push(item));
        const allIds = new Set([...Object.keys(aById), ...Object.keys(bById)]);
        for (const id of allIds) {
            if (!aById[id]) changes.push({ type: 'added', path: `${path}[id=${id}]`, value: bById[id] });
            else if (!bById[id]) changes.push({ type: 'removed', path: `${path}[id=${id}]`, value: aById[id] });
            else deepDiff(aById[id], bById[id], `${path}[id=${id}]`, changes);
        }
        // Index-based for items without id
        const maxLen = Math.max(aNoId.length, bNoId.length);
        for (let i = 0; i < maxLen; i++) {
            if (i >= aNoId.length) changes.push({ type: 'added', path: `${path}[${i}]`, value: bNoId[i] });
            else if (i >= bNoId.length) changes.push({ type: 'removed', path: `${path}[${i}]`, value: aNoId[i] });
            else deepDiff(aNoId[i], bNoId[i], `${path}[${i}]`, changes);
        }
        return changes;
    }

    // Both objects
    if (ta === 'object' && tb === 'object' && a !== null && b !== null) {
        const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of allKeys) {
            const ka = a[k], kb = b[k];
            const newPath = path ? `${path}.${k}` : k;
            if (ka === undefined) changes.push({ type: 'added', path: newPath, value: kb });
            else if (kb === undefined) changes.push({ type: 'removed', path: newPath, value: ka });
            else deepDiff(ka, kb, newPath, changes);
        }
        return changes;
    }

    // Primitive change
    if (JSON.stringify(a) !== JSON.stringify(b)) {
        changes.push({ type: 'changed', path, from: a, to: b });
    }
    return changes;
}

// ── Pretty print a value (summarized) ─────────────────────────────────────
function summarize(val, indent = '    ') {
    if (val === null || val === undefined) return String(val);
    if (typeof val !== 'object') return JSON.stringify(val);
    if (Array.isArray(val)) {
        if (val.length === 0) return '[]';
        return `[Array(${val.length})]`;
    }
    // Object - show key fields
    const keys = Object.keys(val);
    const important = ['id', 'type', 'material_id', 'start', 'duration', 'name', 'file_Path',
        'metetype', 'source_timerange', 'target_timerange', 'extra_material_refs',
        'in_point', 'out_point', 'path', 'anim_name'];
    const shown = important.filter(k => val[k] !== undefined)
        .map(k => `${k}=${JSON.stringify(val[k])}`);
    if (shown.length === 0) {
        const first3 = keys.slice(0, 3).map(k => `${k}=${JSON.stringify(val[k])}`);
        return `{ ${first3.join(', ')}${keys.length > 3 ? ' ...' : ''} }`;
    }
    return `{ ${shown.join(', ')} }`;
}

// ── Noise filter: skip paths that are just timestamps/counts ──────────────
const NOISE_PATHS = [
    /\.update_time$/, /\.create_time$/, /\.import_time/, /\.tm_draft_/,
    /\[len=\d+\]$/, // array length markers
];
function isNoise(changePath) {
    return NOISE_PATHS.some(re => re.test(changePath));
}

// ── Group changes by top-level key ─────────────────────────────────────────
function groupChanges(changes) {
    const groups = {};
    for (const c of changes) {
        if (isNoise(c.path)) continue;
        const top = c.path.split('.')[0].replace(/\[.*/, '');
        if (!groups[top]) groups[top] = [];
        groups[top].push(c);
    }
    return groups;
}

// ── Main diff display ───────────────────────────────────────────────────────
function showContentDiff(beforeFiles, afterFiles) {
    // Find all draft_content.json paths
    const contentKeys = Object.keys(afterFiles).filter(k => k.endsWith('draft_content.json'));

    for (const key of contentKeys) {
        const a = beforeFiles[key];
        const b = afterFiles[key];
        if (!a || !b) continue;
        if (a.md5 === b.md5) {
            console.log(`\n  ⬜ ${key} — không thay đổi`);
            continue;
        }
        console.log(`\n  📝 ${key}`);
        console.log(`     Size: ${fmtSize(a.size)} → ${fmtSize(b.size)}`);

        if (!a.content || !b.content) {
            console.log('     [Không đọc được nội dung]');
            continue;
        }

        const changes = deepDiff(a.content, b.content);
        const groups = groupChanges(changes);

        if (Object.keys(groups).length === 0) {
            console.log('     [Chỉ có timestamps thay đổi]');
            continue;
        }

        // Sections we care about most
        const PRIORITY = ['tracks', 'materials', 'keyframes', 'relationships',
            'canvas_config', 'config', 'duration', 'fps'];

        const orderedKeys = [
            ...PRIORITY.filter(k => groups[k]),
            ...Object.keys(groups).filter(k => !PRIORITY.includes(k))
        ];

        for (const section of orderedKeys) {
            const schanges = groups[section];
            console.log(`\n  ┌─ [${section}] — ${schanges.length} thay đổi`);
            for (const c of schanges.slice(0, 30)) {
                const pathShort = c.path.replace(new RegExp(`^${section}\\.?`), '');
                if (c.type === 'added') {
                    console.log(`  │  🟢 THÊM  ${pathShort}`);
                    console.log(`  │       → ${summarize(c.value)}`);
                } else if (c.type === 'removed') {
                    console.log(`  │  🔴 XÓA   ${pathShort}`);
                    console.log(`  │       ← ${summarize(c.value)}`);
                } else {
                    // changed - skip if very long
                    const fromStr = JSON.stringify(c.from);
                    const toStr = JSON.stringify(c.to);
                    if (fromStr.length > 300 && toStr.length > 300) continue; // skip huge blobs
                    console.log(`  │  🟡 SỬA   ${pathShort}`);
                    console.log(`  │       ${fromStr.slice(0, 120)} → ${toStr.slice(0, 120)}`);
                }
            }
            if (schanges.length > 30) console.log(`  │  ... và ${schanges.length - 30} thay đổi nữa`);
            console.log('  └─');
        }
    }
}

function showFileDiff(before, after) {
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const added = [], removed = [], modified = [];
    for (const k of [...allKeys].sort()) {
        const a = before[k], b = after[k];
        if (!a) { added.push({ k, b }); continue; }
        if (!b) { removed.push({ k, a }); continue; }
        if (a.type === 'dir' && b.type === 'dir') continue;
        if (a.md5 !== b.md5) modified.push({ k, a, b });
    }

    if (added.length) {
        console.log(`\n🟢 FILES MỚI (${added.length}):`);
        added.filter(x => x.b.type === 'file').forEach(({ k, b }) =>
            console.log(`   ${k}  (${fmtSize(b.size)})`));
    }
    if (removed.length) {
        console.log(`\n🔴 FILES BỊ XÓA (${removed.length}):`);
        removed.filter(x => x.a.type === 'file').forEach(({ k, a }) =>
            console.log(`   ${k}  (${fmtSize(a.size)})`));
    }
    if (modified.length) {
        console.log(`\n🟡 FILES THAY ĐỔI (${modified.length}):`);
        for (const { k, a, b } of modified) {
            const diff = b.size - a.size;
            console.log(`   ${k}  ${fmtSize(a.size)} → ${fmtSize(b.size)}  (${diff >= 0 ? '+' : ''}${fmtSize(Math.abs(diff))})`);
        }
    }

    // Deep diff draft_content.json
    const hasContentChanges = modified.some(x => x.k.endsWith('draft_content.json'));
    if (hasContentChanges) {
        console.log('\n──────────────────────────────────────────────────────');
        console.log('🔬 PHÂN TÍCH CHI TIẾT draft_content.json:');
        showContentDiff(before, after);
    }
}

// ── Prompt helper ──────────────────────────────────────────────────────────
function prompt(msg) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(msg, ans => { rl.close(); resolve(ans); });
    });
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
    console.log('\n' + '═'.repeat(60));
    console.log('  CapCut Stage Checker — Deep Diff Tool');
    console.log(`  Project: ${projectDir}`);
    console.log('═'.repeat(60));

    console.log('\n📸 Đang chụp snapshot TRƯỚC...');
    const before = scanDir(projectDir);
    const beforeCount = Object.values(before).filter(v => v.type === 'file').length;
    console.log(`   ✅ Captured ${beforeCount} files`);

    console.log('\n👉 Bây giờ hãy làm thao tác trong CapCut (thêm media, sync, animation...)');
    await prompt('   Xong rồi bấm Enter để chụp snapshot SAU...\n');

    console.log('\n📸 Đang chụp snapshot SAU...');
    const after = scanDir(projectDir);
    const afterCount = Object.values(after).filter(v => v.type === 'file').length;
    console.log(`   ✅ Captured ${afterCount} files`);

    console.log('\n' + '═'.repeat(60));
    console.log('📊 KẾT QUẢ DIFF:');
    console.log('═'.repeat(60));

    showFileDiff(before, after);

    console.log('\n' + '═'.repeat(60));
    console.log('✅ Done!\n');

    // Optionally keep looping
    let cont = true;
    while (cont) {
        const ans = await prompt('\n🔁 Làm tiếp 1 thao tác nữa? (Enter = tiếp, q = thoát): ');
        if (ans.toLowerCase() === 'q' || ans.toLowerCase() === 'quit') { cont = false; break; }

        const prevAfter = after;
        console.log('\n📸 Chụp snapshot SAU thao tác mới...');
        const newAfter = scanDir(projectDir);
        console.log('\n' + '═'.repeat(60));
        showFileDiff(prevAfter, newAfter);
        console.log('\n' + '═'.repeat(60));
        Object.assign(after, newAfter);
    }

    console.log('\n👋 Thoát.\n');
    process.exit(0);
})();
