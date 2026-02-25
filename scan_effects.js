'use strict';
const fs = require('fs');
const path = require('path');

const effectDir = 'C:\\Users\\huylq\\AppData\\Local\\CapCut\\User Data\\Cache\\effect';
const catalog = [];

for (const effectId of fs.readdirSync(effectDir)) {
    const effectPath = path.join(effectDir, effectId);
    if (!fs.statSync(effectPath).isDirectory()) continue;

    const subDirs = fs.readdirSync(effectPath).filter(n => !n.endsWith('_tmp'));
    for (const hash of subDirs) {
        const hashPath = path.join(effectPath, hash);
        if (!fs.statSync(hashPath).isDirectory()) continue;

        const cfgPath = path.join(hashPath, 'config.json');
        if (!fs.existsSync(cfgPath)) continue;

        try {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            const links = cfg.effect && cfg.effect.Link;
            const type = links && links[0] ? links[0].type : 'unknown';
            const name = cfg.name || '';
            catalog.push({ id: effectId, hash, name, type, path: hashPath });
        } catch (e) { /* skip */ }
    }
}

// Group by type
const byType = {};
for (const e of catalog) {
    if (!byType[e.type]) byType[e.type] = [];
    byType[e.type].push(e);
}

console.log('=== Effect Types Summary ===');
for (const [type, items] of Object.entries(byType)) {
    console.log('\nType: ' + type + ' (' + items.length + ' effects)');
    items.slice(0, 8).forEach(e =>
        console.log('  id=' + e.id + '  name=' + (e.name || '(no name)'))
    );
    if (items.length > 8) console.log('  ... và ' + (items.length - 8) + ' effects nữa');
}
console.log('\nTotal:', catalog.length);

fs.writeFileSync(path.join(__dirname, 'effect_catalog.json'), JSON.stringify(catalog, null, 2));
console.log('\nSaved to effect_catalog.json');
