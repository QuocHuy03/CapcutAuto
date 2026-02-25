'use strict';

const fs = require('fs');
const path = require('path');

const projectDir = 'C:\\Users\\LYN HIEN\\AppData\\Local\\CapCut\\User Data\\Projects\\com.lveditor.draft\\0224';
const fp = path.join(projectDir, 'draft_content.json.bak');

const txt = fs.readFileSync(fp, 'utf8');
const draft = JSON.parse(txt);

const extra = draft.extra_info || {};
const frags = extra.subtitle_fragment_info_list || [];

console.log('frags len:', frags.length);

if (frags[0]) {
  console.log('keys of first fragment:', Object.keys(frags[0]));
  console.log('first fragment sample:', JSON.stringify(frags[0], null, 2).slice(0, 1200));
}

