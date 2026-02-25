'use strict';
/**
 * capcut_make_project.js
 * Tự động tạo CapCut project từ folder ảnh + file audio.
 *
 * Usage:
 *   node capcut_make_project.js --images <folder> --audio <file.mp3> [options]
 *
 * Options:
 *   --images  <dir>     Thư mục chứa ảnh (*.jpg, *.jpeg, *.png, *.webp)
 *   --audio   <file>    File audio (.mp3, .m4a, .wav)  [dùng 1 file, lặp nếu cần]
 *   --out     <dir>     Thư mục output project CapCut  (default: ./out_project)
 *   --anim    <id>      Effect ID animation (default: 6798332733694153230 = Zoom In)
 *   --animdur <ms>      Thời lượng animation ms        (default: 500)
 *   --name    <name>    Tên project                    (default: MyProject)
 *   --fps     <num>     FPS                           (default: 30)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Parse args ──────────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
    args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const imagesDir = args.images;
const audioFile = args.audio;
const outDir = args.out || './out_project';
const animId = args.anim || '6798332733694153230';   // Zoom In
const animDurMs = parseInt(args.animdur || '500', 10);
const projectName = args.name || 'MyProject';
const fps = parseFloat(args.fps || '30');

if (!imagesDir || !audioFile) {
    console.error('Usage: node capcut_make_project.js --images <dir> --audio <file> [--out <dir>] [--anim <effectId>]');
    console.error('\nAvailable animations (from effect_catalog.json):');
    const catFile = path.join(__dirname, 'effect_catalog.json');
    if (fs.existsSync(catFile)) {
        const cat = JSON.parse(fs.readFileSync(catFile, 'utf8'));
        cat.filter(e => e.type === 'InfoSticker').forEach(e =>
            console.error('  id=' + e.id + '  path=' + e.path)
        );
    }
    process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function uuid() {
    return crypto.randomUUID().toUpperCase();
}

function toForwardSlash(p) {
    return p.replace(/\\/g, '/');
}

// Read image dimensions from JPEG/PNG header (no external deps)
function getImageSize(filePath) {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.jpg' || ext === '.jpeg') {
        // Find SOF marker
        let i = 2;
        while (i < buf.length) {
            if (buf[i] !== 0xFF) break;
            const marker = buf[i + 1];
            const len = buf.readUInt16BE(i + 2);
            if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) ||
                (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
                return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
            }
            i += 2 + len;
        }
    } else if (ext === '.png') {
        if (buf.readUInt32BE(0) === 0x89504e47) {
            return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
    } else if (ext === '.webp') {
        // RIFF....WEBPVP8
        if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
            const vp8tag = buf.slice(12, 16).toString();
            if (vp8tag === 'VP8 ') {
                const w = (buf.readUInt16LE(26) & 0x3FFF);
                const h = (buf.readUInt16LE(28) & 0x3FFF);
                return { width: w, height: h };
            } else if (vp8tag === 'VP8L') {
                const bits = buf.readUInt32LE(21);
                return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
            }
        }
    }
    return { width: 1280, height: 720 }; // fallback
}

// Get MP3 duration from Xing/VBRI header or estimate from file size
function getAudioDurationUs(filePath) {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.mp3') {
        // Try to find Xing/Info/VBRI frame
        for (let i = 0; i < Math.min(buf.length - 4, 10000); i++) {
            if (buf[i] === 0xFF && (buf[i + 1] & 0xE0) === 0xE0) {
                const b1 = buf[i + 1], b2 = buf[i + 2];
                const version = (b1 >> 3) & 3;   // 2=MPEG2, 3=MPEG1
                const layer = (b1 >> 1) & 3;   // 3=LayerI, 2=II, 1=III
                const brtIdx = (b2 >> 4) & 0xF;
                const srIdx = (b2 >> 2) & 3;
                if (version === 3 && layer === 1 && brtIdx > 0 && brtIdx < 15 && srIdx < 3) {
                    const sampleRates = [44100, 48000, 32000];
                    const bitRates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
                    const sr = sampleRates[srIdx];
                    const br = bitRates[brtIdx] * 1000;
                    if (sr && br) {
                        // Check for Xing/Info at offset 36 (MPEG1, stereo)
                        const xingOffset = i + 4 + 32;
                        if (xingOffset + 8 < buf.length) {
                            const tag = buf.slice(xingOffset, xingOffset + 4).toString();
                            if (tag === 'Xing' || tag === 'Info') {
                                const flags = buf.readUInt32BE(xingOffset + 4);
                                if (flags & 1) {
                                    const frames = buf.readUInt32BE(xingOffset + 8);
                                    const samplesPerFrame = 1152;
                                    return Math.round(frames * samplesPerFrame / sr * 1e6);
                                }
                            }
                        }
                        // Fallback: estimate from file size and bitrate
                        const fileSizeBits = buf.length * 8;
                        return Math.round(fileSizeBits / br * 1e6);
                    }
                }
                break;
            }
        }
        // Last resort: assume 128kbps
        return Math.round(buf.length * 8 / 128000 * 1e6);
    }

    // For other formats, rough estimate
    return Math.round(buf.length * 8 / 128000 * 1e6);
}

// Resolve animation effect path from catalog
function resolveAnimPath(effectId) {
    const catFile = path.join(__dirname, 'effect_catalog.json');
    if (fs.existsSync(catFile)) {
        const cat = JSON.parse(fs.readFileSync(catFile, 'utf8'));
        const found = cat.find(e => e.id === effectId);
        if (found) return found.path;
    }
    // Fallback: scan directly
    const effectDir = 'C:\\Users\\huylq\\AppData\\Local\\CapCut\\User Data\\Cache\\effect';
    const effectPath = path.join(effectDir, effectId);
    if (fs.existsSync(effectPath)) {
        const hashes = fs.readdirSync(effectPath).filter(n => !n.endsWith('_tmp'));
        if (hashes.length > 0) return toForwardSlash(path.join(effectPath, hashes[0]));
    }
    return '';
}

// ── Template builders ────────────────────────────────────────────────────────
function makeSpeed(id) {
    return { curve_speed: null, id, mode: 0, speed: 1, type: 'speed' };
}

function makePlaceholder(id) {
    return {
        error_path: '', error_text: '', id, meta_type: 'none',
        res_path: '', res_text: '', type: 'placeholder_info'
    };
}

function makeCanvas(id) {
    return {
        album_image: '', blur: 0, color: '', id, image: '',
        image_id: '', image_name: '', source_platform: 0, team_id: '', type: 'canvas_color'
    };
}

function makeMaterialColor(id) {
    return { id, type: 'material_color', color: '' };
}

function makeVocalSeparation(id) {
    return { id, type: 'vocal_separation', edit_type: 0 };
}

function makeSoundChannelMapping(id) {
    return {
        id, type: '', audio_channel_mapping: {
            audio_channel: 0,
            id: uuid(), is_config_open: false, type: 'none'
        }
    };
}

function makeBeat(id) {
    return {
        ai_beats: {
            beat_speed_infos: [], beats_path: '', beats_url: '',
            melody_path: '', melody_percents: [0.0], melody_url: ''
        },
        enable_ai_beats: false, gear: 404, gear_count: 0,
        id, mode: 404, type: 'beats', user_beats: [], user_delete_ai_beats: null
    };
}

function makeMaterialAnimation(id, effectId, effectPath, animDurationUs) {
    if (!effectId) {
        return { animations: [], id, multi_language_current: 'none', type: 'sticker_animation' };
    }
    return {
        animations: [{
            anim_adjust_params: null,
            category_id: '6824',
            category_name: '',
            duration: animDurationUs,
            id: effectId,
            material_type: 'video',
            name: 'Zoom In',
            panel: 'video',
            path: toForwardSlash(effectPath),
            platform: 'all',
            request_id: '',
            resource_id: effectId,
            source_platform: 1,
            start: 0,
            third_resource_id: effectId,
            type: 'in'
        }],
        id,
        multi_language_current: 'none',
        type: 'sticker_animation'
    };
}

function makeVideoMaterial(id, imgPath, width, height, audioAlgDurationUs) {
    const fwdPath = toForwardSlash(imgPath);
    return {
        aigc_history_id: '', aigc_item_id: '', aigc_type: 'none',
        audio_fade: null, beauty_body_auto_preset: null, beauty_body_preset_id: '',
        beauty_face_auto_preset: { name: '', preset_id: '', rate_map: '', scene: '' },
        beauty_face_auto_preset_infos: [], beauty_face_preset_infos: [],
        cartoon_path: '', category_id: '', category_name: 'local',
        check_flag: 62978047, content_feature_info: null, corner_pin: null,
        crop: {
            lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1,
            upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0
        },
        crop_ratio: 'free', crop_scale: 1,
        duration: 10800000000, // 3 hours = effectively infinite for photo
        extra_type_option: 0, formula_id: '', freeze: null,
        has_audio: false, has_sound_separated: false,
        height, id,
        intensifies_audio_path: '', intensifies_path: '',
        is_ai_generate_content: false, is_copyright: false,
        is_text_edit_overdub: false, is_unified_beauty_mode: false,
        live_photo_cover_path: '', live_photo_timestamp: -1,
        local_id: '', local_material_from: '', local_material_id: '',
        material_id: '', material_name: path.basename(imgPath), material_url: '',
        matting: {
            custom_matting_id: '', enable_matting_stroke: false, expansion: 0,
            feather: 0, flag: 0, has_use_quick_brush: false, has_use_quick_eraser: false,
            interactiveTime: [], path: '', reverse: false, strokes: []
        },
        media_path: '', multi_camera_info: null, object_locked: null, origin_material_id: '',
        path: fwdPath, picture_from: 'none',
        picture_set_category_id: '', picture_set_category_name: '',
        request_id: '', reverse_intensifies_path: '', reverse_path: '',
        smart_match_info: null, smart_motion: null, source: 0, source_platform: 0,
        stable: { matrix_path: '', stable_level: 0, time_range: { duration: 0, start: 0 } },
        surface_trackings: [], team_id: '', type: 'photo',
        video_algorithm: {
            ai_background_configs: [], ai_expression_driven: null,
            ai_in_painting_config: [], ai_motion_driven: null,
            aigc_generate: null, aigc_generate_list: [], algorithms: [],
            complement_frame_config: null, deflicker: null, gameplay_configs: [],
            image_interpretation: null, motion_blur_config: null,
            mouth_shape_driver: null, noise_reduction: null, path: '',
            quality_enhance: null, skip_algorithm_index: [], smart_complement_frame: null,
            story_video_modify_video_config: { is_overwrite_last_video: false, task_id: '', tracker_task_id: '' },
            super_resolution: null,
            time_range: { duration: audioAlgDurationUs, start: 0 }
        },
        video_mask_shadow: { alpha: 0, angle: 0, blur: 0, color: '', distance: 0, path: '', resource_id: '' },
        video_mask_stroke: {
            alpha: 0, color: '', distance: 0, horizontal_shift: 0,
            path: '', resource_id: '', size: 0, texture: 0, type: '', vertical_shift: 0
        },
        width
    };
}

function makeAudioMaterial(id, audPath, durationUs) {
    const fwdPath = toForwardSlash(audPath);
    const name = path.basename(audPath);
    return {
        ai_music_enter_from: '', ai_music_generate_scene: 0, ai_music_type: 0,
        aigc_history_id: '', aigc_item_id: '', app_id: 0,
        category_id: '', category_name: 'local', check_flag: 1,
        cloned_model_type: '', copyright_limit_type: 'none',
        duration: durationUs, effect_id: '', formula_id: '', id,
        intensifies_path: '', is_ai_clone_tone: false, is_ai_clone_tone_post: false,
        is_text_edit_overdub: false, is_ugc: false,
        local_material_id: uuid().toLowerCase(),
        lyric_type: 0, mock_tone_speaker: '', moyin_emotion: '',
        music_id: uuid().toLowerCase(), music_source: '', name,
        path: fwdPath, pgc_id: '', pgc_name: '', query: '',
        request_id: '', resource_id: '', search_id: '',
        similiar_music_info: { original_song_id: '', original_song_name: '' },
        sound_separate_type: '', source_from: '', source_platform: 0,
        team_id: '', text_id: '', third_resource_id: '',
        tone_category_id: '', tone_category_name: '', tone_effect_id: '', tone_effect_name: '',
        tone_emotion_name_key: '', tone_emotion_role: '', tone_emotion_scale: 0.0,
        tone_emotion_selection: '', tone_emotion_style: '', tone_platform: '',
        tone_second_category_id: '', tone_second_category_name: '',
        tone_speaker: '', tone_type: '',
        tts_benefit_info: { benefit_amount: -1, benefit_log_extra: '', benefit_log_id: '', benefit_type: 'none' },
        tts_generate_scene: '', tts_task_id: '', type: 'extract_music',
        video_id: '', wave_points: []
    };
}

function makeVideoSegment(segId, matId, refs, durationUs, startUs) {
    return {
        caption_info: null, cartoon: false,
        clip: {
            alpha: 1, flip: { horizontal: false, vertical: false },
            rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }
        },
        color_correct_alg_result: '', common_keyframes: [], desc: '',
        digital_human_template_group_id: '',
        enable_adjust: true, enable_adjust_mask: false, enable_color_correct_adjust: false,
        enable_color_curves: true, enable_color_match_adjust: false, enable_color_wheels: true,
        enable_hsl: false, enable_hsl_curves: true, enable_lut: true,
        enable_mask_shadow: false, enable_mask_stroke: false, enable_smart_color_adjust: false,
        enable_video_mask: true,
        extra_material_refs: refs,
        group_id: '',
        hdr_settings: { intensity: 1, mode: 1, nits: 1000 },
        id: segId, intensifies_audio: false, is_loop: false, is_placeholder: false,
        is_tone_modify: false, keyframe_refs: [], last_nonzero_volume: 1,
        lyric_keyframes: null, material_id: matId, raw_segment_id: '',
        render_index: 0, render_timerange: { duration: 0, start: 0 },
        responsive_layout: {
            enable: false, horizontal_pos_layout: 0, size_layout: 0,
            target_follow: '', vertical_pos_layout: 0
        },
        reverse: false, source: 'segmentsourcenormal',
        source_timerange: { duration: durationUs, start: 0 },
        speed: 1, state: 0,
        target_timerange: { duration: durationUs, start: startUs },
        template_id: '', template_scene: 'default',
        track_attribute: 0, track_render_index: 0,
        uniform_scale: { on: true, value: 1 },
        visible: true, volume: 1
    };
}

function makeAudioSegment(segId, matId, refs, durationUs, startUs) {
    return {
        caption_info: null, cartoon: false, clip: null,
        color_correct_alg_result: '', common_keyframes: [], desc: '',
        digital_human_template_group_id: '',
        enable_adjust: false, enable_adjust_mask: false, enable_color_correct_adjust: false,
        enable_color_curves: true, enable_color_match_adjust: false, enable_color_wheels: true,
        enable_hsl: false, enable_hsl_curves: true, enable_lut: false,
        enable_mask_shadow: false, enable_mask_stroke: false, enable_smart_color_adjust: false,
        enable_video_mask: true,
        extra_material_refs: refs,
        group_id: '', hdr_settings: null,
        id: segId, intensifies_audio: false, is_loop: false, is_placeholder: false,
        is_tone_modify: false, keyframe_refs: [], last_nonzero_volume: 1,
        lyric_keyframes: null, material_id: matId, raw_segment_id: '',
        render_index: 0, render_timerange: { duration: 0, start: 0 },
        responsive_layout: {
            enable: false, horizontal_pos_layout: 0, size_layout: 0,
            target_follow: '', vertical_pos_layout: 0
        },
        reverse: false, source: 'segmentsourcenormal',
        source_timerange: { duration: durationUs, start: 0 },
        speed: 1, state: 0,
        target_timerange: { duration: durationUs, start: startUs },
        template_id: '', template_scene: 'default',
        track_attribute: 0, track_render_index: 1,
        uniform_scale: null, visible: true, volume: 1
    };
}

// ── Main ─────────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(55));
console.log('  CapCut Project Generator');
console.log('═'.repeat(55));

// 1. Scan images
const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const images = fs.readdirSync(imagesDir)
    .filter(f => IMG_EXTS.has(path.extname(f).toLowerCase()))
    .sort()
    .map(f => path.join(imagesDir, f));

if (images.length === 0) { console.error('No images found in', imagesDir); process.exit(1); }
console.log(`📸 Images: ${images.length}`);

// 2. Get audio duration
const audioDurationUs = getAudioDurationUs(audioFile);
console.log(`🎵 Audio: ${path.basename(audioFile)}  (${(audioDurationUs / 1e6).toFixed(2)}s)`);

// 3. Per-image duration = total audio / num images
const imgDurationUs = Math.round(audioDurationUs / images.length);
const animDurationUs = animDurMs * 1000;
const algDurationUs = imgDurationUs + animDurationUs; // algorithm analysis window

// 4. Resolve animation effect
const effectPath = resolveAnimPath(animId);
console.log(`✨ Animation: id=${animId}  path=${effectPath || '(not found)'}`);

// 5. Build IDs and materials
const videoTrackId = uuid();
const audioTrackId = uuid();

// Per-image material IDs
const imgMats = images.map((imgPath, i) => {
    const size = getImageSize(imgPath);
    const matId = uuid();
    const speedId = uuid();
    const placeholderId = uuid();
    const canvasId = uuid();
    const animMatId = uuid();
    const matColorId = uuid();
    const vocalSepId = uuid();
    return {
        imgPath, ...size, matId, speedId, placeholderId, canvasId,
        animMatId, matColorId, vocalSepId
    };
});

// Per-audio material IDs
const audioPath = path.resolve(audioFile);
const audioMats = [audioPath].map((ap, i) => {  // support 1 audio for now
    const durationUs = audioDurationUs;
    const matId = uuid();
    const speedId = uuid();
    const placeholderId = uuid();
    const beatId = uuid();
    const soundChannelId = uuid();
    const vocalSepId = uuid();
    return {
        audioPath: ap, durationUs, matId, speedId, placeholderId,
        beatId, soundChannelId, vocalSepId
    };
});

// 6. Build video segments
let timeOffset = 0;
const videoSegs = imgMats.map(m => {
    const refs = [
        m.speedId, m.placeholderId, m.canvasId,
        m.animMatId, m.matColorId, m.vocalSepId
    ];
    const seg = makeVideoSegment(uuid(), m.matId, refs, imgDurationUs, timeOffset);
    timeOffset += imgDurationUs;
    return seg;
});

// 7. Build audio segments
let audioOffset = 0;
const audioSegs = audioMats.map(m => {
    const refs = [m.speedId, m.placeholderId, m.beatId, m.soundChannelId, m.vocalSepId];
    const seg = makeAudioSegment(uuid(), m.matId, refs, m.durationUs, audioOffset);
    audioOffset += m.durationUs;
    return seg;
});

// 8. Build draft_content.json
const draft = {
    canvas_config: { background: null, height: 1080, ratio: 'original', width: 1920 },
    color_space: -1,
    config: {
        adjust_max_index: 1, attachment_info: [], combination_max_index: 1,
        export_range: null, extract_audio_last_index: 1,
        lyrics_recognition_id: '', lyrics_sync: true, lyrics_taskinfo: [],
        maintrack_adsorb: true, material_save_mode: 0,
        multi_language_current: 'none', multi_language_list: [],
        multi_language_main: 'none', multi_language_mode: 'none',
        original_sound_last_index: 1, record_audio_last_index: 1,
        sticker_max_index: 1, subtitle_keywords_config: null,
        subtitle_recognition_id: '', subtitle_sync: true, subtitle_taskinfo: [],
        system_font_list: [], use_float_render: false,
        video_mute: false, zoom_info_params: null
    },
    cover: null,
    create_time: 0,
    draft_type: 'video',
    duration: audioDurationUs,
    extra_info: null,
    fps,
    free_render_index_mode_on: false,
    function_assistant_info: {
        audio_noise_segid_list: [], auto_adjust: false, auto_adjust_fixed: false,
        auto_adjust_fixed_value: 50.0, auto_adjust_segid_list: [], auto_caption: false,
        auto_caption_segid_list: [], auto_caption_template_id: '', caption_opt: false,
        caption_opt_segid_list: [], color_correction: false, color_correction_fixed: false,
        color_correction_fixed_value: 50.0, color_correction_segid_list: [],
        deflicker_segid_list: [], enhance_quality: false, enhance_quality_fixed: false,
        enhance_quality_segid_list: [], enhance_voice_segid_list: [], enhande_voice: false,
        enhande_voice_fixed: false, eye_correction: false, eye_correction_segid_list: [],
        fixed_rec_applied: false, fps: { den: 1, num: 0 }, normalize_loudness: false,
        normalize_loudness_audio_denoise_segid_list: [], normalize_loudness_fixed: false,
        normalize_loudness_segid_list: [], retouch: false, retouch_fixed: false,
        retouch_segid_list: [], smart_rec_applied: false, smart_segid_list: [],
        smooth_slow_motion: false, smooth_slow_motion_fixed: false, video_noise_segid_list: []
    },
    group_container: null,
    id: uuid(),
    is_drop_frame_timecode: false,
    keyframe_graph_list: [],
    keyframes: {
        adjusts: [], audios: [], effects: [], filters: [], handwrites: [],
        stickers: [], texts: [], videos: []
    },
    last_modified_platform: {
        app_id: 359289, app_source: 'cc', app_version: '8.1.1',
        device_id: '', hard_disk_id: '', mac_address: '', os: 'windows', os_version: '10.0.19045'
    },
    lyrics_effects: [],
    materials: {
        ai_translates: [], audio_balances: [], audio_effects: [], audio_fades: [],
        audio_pannings: [], audio_pitch_shifts: [], audio_track_indexes: [],
        audios: audioMats.map(m => makeAudioMaterial(m.matId, m.audioPath, m.durationUs)),
        beats: audioMats.map(m => makeBeat(m.beatId)),
        canvases: imgMats.map(m => makeCanvas(m.canvasId)),
        chromas: [], color_curves: [], common_mask: [],
        digital_human_model_dressing: [], digital_humans: [], drafts: [], effects: [],
        flowers: [], green_screens: [], handwrites: [], hsl: [], hsl_curves: [], images: [],
        log_color_wheels: [], loudnesses: [], manual_beautys: [], manual_deformations: [],
        material_animations: imgMats.map(m => makeMaterialAnimation(m.animMatId, animId, effectPath, animDurationUs)),
        material_colors: imgMats.map(m => makeMaterialColor(m.matColorId)),
        multi_language_refs: [],
        placeholder_infos: [
            ...imgMats.map(m => makePlaceholder(m.placeholderId)),
            ...audioMats.map(m => makePlaceholder(m.placeholderId)),
        ],
        placeholders: [], plugin_effects: [], primary_color_wheels: [], realtime_denoises: [],
        shapes: [], smart_crops: [], smart_relights: [],
        sound_channel_mappings: audioMats.map(m => makeSoundChannelMapping(m.soundChannelId)),
        speeds: [
            ...imgMats.map(m => makeSpeed(m.speedId)),
            ...audioMats.map(m => makeSpeed(m.speedId)),
        ],
        stickers: [], tail_leaders: [], text_templates: [], texts: [], time_marks: [],
        transitions: [], video_effects: [], video_radius: [], video_shadows: [],
        video_strokes: [], video_trackings: [],
        videos: imgMats.map(m => makeVideoMaterial(m.matId, m.imgPath, m.width, m.height, algDurationUs)),
        vocal_beautifys: [],
        vocal_separations: [
            ...imgMats.map(m => makeVocalSeparation(m.vocalSepId)),
            ...audioMats.map(m => makeVocalSeparation(m.vocalSepId)),
        ],
    },
    mutable_config: null,
    name: '',
    new_version: '159.0.0',
    path: '',
    platform: {
        app_id: 359289, app_source: 'cc', app_version: '8.1.1',
        device_id: '', hard_disk_id: '', mac_address: '', os: 'windows', os_version: '10.0.19045'
    },
    relationships: [],
    render_index_track_mode_on: true,
    retouch_cover: null,
    smart_ads_info: { draft_url: '', page_from: '', routine: '' },
    source: 'default',
    static_cover_image_path: '',
    time_marks: null,
    tracks: [
        {
            attribute: 0, flag: 0, id: videoTrackId, is_default_name: true, name: '',
            segments: videoSegs, type: 'video'
        },
        {
            attribute: 0, flag: 0, id: audioTrackId, is_default_name: true, name: '',
            segments: audioSegs, type: 'audio'
        },
    ],
    uneven_animation_template_info: { composition: '', content: '', order: '', sub_template_info_list: [] },
    update_time: 0,
    version: 360000
};

// 9. Write output project
const projectId = uuid();
const timelineId = uuid();
const now = Date.now() * 1000; // microseconds

const absOut = path.resolve(outDir);
const timelinesDir = path.join(absOut, 'Timelines', timelineId);
fs.mkdirSync(timelinesDir, { recursive: true });
fs.mkdirSync(path.join(timelinesDir, 'common_attachment'), { recursive: true });
fs.mkdirSync(path.join(absOut, 'common_attachment'), { recursive: true });

const draftJson = JSON.stringify(draft);

// Write draft_content.json to both locations
fs.writeFileSync(path.join(absOut, 'draft_content.json'), draftJson);
fs.writeFileSync(path.join(timelinesDir, 'draft_content.json'), draftJson);

// draft_meta_info.json
const metaInfo = {
    cloud_draft_cover: false, cloud_draft_sync: false, cloud_package_completed_time: '',
    draft_cloud_capcut_purchase_info: '', draft_cloud_last_action_download: false,
    draft_cloud_package_type: '', draft_cloud_purchase_info: '', draft_cloud_template_id: '',
    draft_cloud_tutorial_info: '', draft_cloud_videocut_purchase_info: '',
    draft_cover: 'draft_cover.jpg', draft_deeplink_url: '',
    draft_enterprise_info: {
        draft_enterprise_extra: '', draft_enterprise_id: '',
        draft_enterprise_name: '', enterprise_material: []
    },
    draft_fold_path: toForwardSlash(absOut),
    draft_id: projectId,
    draft_is_ae_produce: false, draft_is_ai_packaging_used: false,
    draft_is_ai_shorts: false, draft_is_ai_translate: false,
    draft_is_article_video_draft: false, draft_is_cloud_temp_draft: false,
    draft_is_from_deeplink: 'false', draft_is_invisible: false, draft_is_web_article_video: false,
    draft_materials: [
        {
            type: 0, value: [
                ...imgMats.map(m => ({
                    ai_group_type: '', create_time: Math.floor(Date.now() / 1000),
                    duration: imgDurationUs, extra_info: path.basename(m.imgPath),
                    file_Path: toForwardSlash(m.imgPath),
                    height: m.height, id: m.matId,
                    import_time: Math.floor(Date.now() / 1000),
                    import_time_ms: now, item_source: 1, md5: '',
                    metetype: 'photo',
                    roughcut_time_range: { duration: -1, start: -1 },
                    sub_time_range: { duration: -1, start: -1 },
                    type: 0, width: m.width
                })),
                ...audioMats.map(m => ({
                    ai_group_type: '', create_time: Math.floor(Date.now() / 1000),
                    duration: m.durationUs, extra_info: path.basename(m.audioPath),
                    file_Path: toForwardSlash(m.audioPath),
                    height: 0, id: m.matId,
                    import_time: Math.floor(Date.now() / 1000),
                    import_time_ms: now, item_source: 1, md5: '',
                    metetype: 'music',
                    roughcut_time_range: { duration: m.durationUs, start: 0 },
                    sub_time_range: { duration: -1, start: -1 },
                    type: 0, width: 0
                }))
            ]
        },
        { type: 1, value: [] }, { type: 2, value: [] },
        { type: 3, value: [] }, { type: 6, value: [] }, { type: 7, value: [] }
    ],
    draft_materials_copied_info: [],
    draft_name: projectName,
    draft_need_rename_folder: false, draft_new_version: '',
    draft_removable_storage_device: '',
    draft_root_path: toForwardSlash(path.dirname(absOut)),
    draft_segment_extra_info: [], draft_timeline_materials_size_: 0,
    draft_type: '', draft_web_article_video_enter_from: '',
    tm_draft_cloud_completed: '', tm_draft_cloud_entry_id: -1,
    tm_draft_cloud_modified: 0, tm_draft_cloud_parent_entry_id: -1,
    tm_draft_cloud_space_id: -1, tm_draft_cloud_user_id: -1,
    tm_draft_create: now, tm_draft_modified: now, tm_draft_removed: 0,
    tm_duration: audioDurationUs
};
fs.writeFileSync(path.join(absOut, 'draft_meta_info.json'), JSON.stringify(metaInfo));

// project.json
const projectJson = {
    config: { color_space: -1, render_index_track_mode_on: false, use_float_render: false },
    create_time: now, id: projectId,
    main_timeline_id: timelineId,
    timelines: [{
        create_time: now, id: timelineId, is_marked_delete: false,
        name: 'Timeline 01', update_time: now
    }],
    update_time: now, version: 0
};
fs.writeFileSync(path.join(absOut, 'Timelines', 'project.json'), JSON.stringify(projectJson));

// timeline_layout.json
const layoutJson = {
    dockItems: [{ dockIndex: 0, ratio: 1, timelineIds: [timelineId], timelineNames: ['Timeline 01'] }],
    layoutOrientation: 1
};
fs.writeFileSync(path.join(absOut, 'timeline_layout.json'), JSON.stringify(layoutJson));

// draft_agency_config.json
fs.writeFileSync(path.join(absOut, 'draft_agency_config.json'),
    JSON.stringify({
        is_auto_agency_enabled: false, is_auto_agency_popup: false,
        is_single_agency_mode: false, marterials: null,
        use_converter: false, video_resolution: 720
    }));

// draft_biz_config.json (empty)
fs.writeFileSync(path.join(absOut, 'draft_biz_config.json'), '');

// .locked
fs.writeFileSync(path.join(absOut, '.locked'), '');

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n✅ Project created: ${absOut}`);
console.log(`   Images:    ${images.length} → ${(imgDurationUs / 1e6).toFixed(2)}s each`);
console.log(`   Duration:  ${(audioDurationUs / 1e6).toFixed(2)}s total`);
console.log(`   Animation: ${animId} | duration ${animDurMs}ms`);
console.log(`\n📋 Next steps:`);
console.log(`   Copy the output folder to:`);
console.log(`   C:\\Users\\huylq\\AppData\\Local\\CapCut\\User Data\\Projects\\com.lveditor.draft\\`);
console.log(`   Then open CapCut → project "${projectName}" will appear in the list.\n`);
