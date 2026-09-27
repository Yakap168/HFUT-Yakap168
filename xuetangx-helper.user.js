// ==UserScript==
// @name         学堂在线全能助手 - V4.3.1 (PPTX 讲义 / 视频筛选刷课 / 自动提交 / AI 视觉识图)
// @namespace    http://tampermonkey.net/
// @version      4.3.14
// @description  学堂在线辅助：① 视频课自动刷课（静音 + 倍速 + 播完自动进入下一单元；目录筛选为「视频」时一路上连刷）② 参考资料库（PDF / PPTX / DOCX / TXT / JSON → 切片 → 按题干检索 Top-K → 注入提示词）③ 按题库或大模型(AI)自动作答（单选 / 多选 / 判断 / 填空简答等主观题）④ 选中选项后自动提交 ⑤ 题目提取与题库管理（可导出 JSON）。
// @description  「选中选项 → 自动提交」的实现要点：脚本独立轮询等站点把「提交」点亮再点，随后回读「按钮文案 / 剩余N次 / 页码 / 题干」确认是否真的交上去，没生效才重试；同一份选择只自动交一次，改答案会重新提交；答题任务运行期间由任务自己提交，旁观逻辑不介入。
// @author       Gemini AI Assistant (Based on V3.8)
// @match        https://*.xuetangx.com/*
// @require      https://cdn.bootcdn.net/ajax/libs/jquery/3.6.0/jquery.min.js
// @require      https://cdn.bootcdn.net/ajax/libs/pdf.js/3.11.174/pdf.min.js
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      api.openai.com
// @downloadURL  https://cdn.jsdelivr.net/gh/Yakap168/HFUT-Yakap168@main/xuetangx-helper.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/Yakap168/HFUT-Yakap168@main/xuetangx-helper.user.js
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 可配置参数 ====================
    const SCRIPT_VERSION = '4.3.1';
    const PRE_CLICK_DELAY_MS = 500;      // 普通翻页前的等待（页脚控件多，仍留一拍更稳）
    // 「选中选项 → 点提交」原先是固定 sleep(500)：每题白耗 0.5s，且机器慢时 500ms 内站点 Vue 状态还没刷新、
    // 提交按钮仍带 disable 类 → 取不到按钮转而走"重选选项再试"分支，反而更慢。
    // 现改为轮询"提交按钮是否已可用"，就绪即提交（通常 30~90ms）。
    const OPTION_TO_SUBMIT_POLL_MS = 30;     // 选项 → 提交 的轮询间隔
    // 选中选项后站点约 0.3~0.7s 才去掉提交按钮上的 disable 类（Vue 异步刷新），
    // 所以单次等待上限放到 2s、重试时更宽（见 submitCurrentAnswer）。
    const OPTION_TO_SUBMIT_TIMEOUT_MS = 2000; // 选项 → 提交 的单次等待上限（超时后走兜底分支）
    const SUBMIT_BUTTON_SLOW_WAIT_MS = 3000;  // 重试时的等待上限（站点偶尔慢一拍）
    const DIALOG_POLL_MS = 120;              // 「确认提交」弹窗的轮询间隔（站点渲染弹窗本身需要几十毫秒）
    // 提交动作的健壮化参数（详见 submitCurrentAnswer 注释）
    const OPTION_SELECTED_WAIT_MS = 900;     // 点完选项后，等站点把"已选中"状态同步出来的时间
    const SUBMIT_MAX_ATTEMPTS = 3;           // 「选项 → 提交」整体最多尝试几次（含"点了没生效"的重试）
    const SUBMIT_RETRY_GAP_MS = 500;         // 两次尝试之间的间隔
    // 提交后只需留很短一拍让 DOM 先动起来：翻页与"正确答案"各自都有轮询在等。
    const POST_SUBMIT_DELAY_MS = 600;

    // ---- 选中选项 → 自动提交（实现见「核心功能 8」）----
    const AUTO_SUBMIT_TICK_MS = 250;             // 巡检周期：只在答题页上做一次很轻的判断
    const AUTO_SUBMIT_QUIET_MS = 650;            // 单选/判断题：最后一次选择变化后安静这么久才提交
    const AUTO_SUBMIT_QUIET_MULTI_MS = 1500;     // 多选题：要连着点好几个选项，静默期放长
    const AUTO_SUBMIT_BUTTON_WAIT_MS = 1500;     // 等「提交」按钮变可用；等不到就补点一次选项激活
    const AUTO_SUBMIT_RETRY_COOLDOWN_MS = 2500;  // 失败后的冷却，避免对着禁用按钮连着硬点
    const AUTO_SUBMIT_MAX_TRIES = 2;             // 同一道题最多自动提交几次（含失败重试）
    // 旁观式自动提交自成一套动线，不借答题任务的参数与阶段：站点把「提交」点亮通常比"选中选项"晚 0.5~2s，
    // 等不够就会"选了却不提交"、等太久用户又以为没反应；任务刚结束的一小段时间也不介入，避免两边抢同一次提交。
    const AUTO_SUBMIT_ENABLE_WAIT_MS = 2500;     // 等「提交」按钮点亮的总时长（一次）
    const AUTO_SUBMIT_ENABLE_WAIT2_MS = 1200;    // 补点一次已选中项之后，再等这么久
    const AUTO_SUBMIT_TASK_GRACE_MS = 1500;      // 答题任务结束后的静默期，这段时间不自动提交

    // ---- 答题任务的翻页（严格「提交 → 下一页」动线）----
    const NEXT_CTRL_POLL_MS = 150;       // 提交后轮询页内「下一题/下一页」的间隔
    const NEXT_CTRL_WAIT_MS = 4000;      // 等这么久还没出现页内「下一页」+ 页面也没变化，就认定"本页没有下一页"
    const NEXT_CTRL_RECLICK_MS = 2500;   // 点了"下一页"却没生效时，多久允许补点一次
    const NEXT_CHAPTER_WAIT_MS = 9000;   // 本章答完点页脚 ">" 后，等下一个练习加载的时长

    // ---- 播放器控制条唤醒（静音/倍速都要先让控制条显示出来）----
    // 控制条平时是收起的，鼠标在视频上动一下才显示；收起时静音键要么不在 DOM、要么 opacity:0，
    // 脚本按"可见"去找必然失败，所以要先派发合成鼠标事件把它唤醒。
    const MUTE_WAKE_DELAY_MS = 140;          // 派发合成鼠标事件后，等控制条淡入的时间
    const MUTE_WAKE_MIN_INTERVAL_MS = 700;   // 唤醒动作的最小间隔，避免每轮巡检重复扰动
    const MUTE_VERIFY_DELAY_MS = 220;        // 点完音量键后回读 video.muted 的等待（站点状态同步有延迟）
    const MUTE_RETRY_ROUND_MS = 15000;       // 仍未静音时，多久清空"已试过的音量键"并重试一轮
    const MUTE_MAX_CANDIDATES_PER_ROUND = 3; // 一轮里最多试几个候选控件（点到滑块之类的也不会瞎点太多）

    const VIDEO_TICK_MS = 3000;          // 刷课巡检周期
    const NEXT_UNIT_DELAY_MS = 5000;     // 视频播完后等待再翻页
    const NEXT_UNIT_CONFIRM_MS = 900;    // 点了"下一单元"后，等多久回读"到底跳没跳"
    // 防"一跳跳过好几个单元"的两道闸门：
    const UNIT_SETTLE_MS = 4000;         // 刚切换单元后的静置期，这期间不判"播完"
    const FINISH_STABLE_HITS = 2;        // "播完"需要连续 2 轮巡检（≈6s）都成立才算数
    const NON_VIDEO_DWELL_MS = 6000;     // 非视频页停留多久才考虑翻页
    // 「只刷视频」（目录筛选=视频）模式下，视频单元里播放器迟迟起不来时的宽限期：
    // 期间不翻页，避免把"加载慢"误当成"这个单元没有可播视频"而跳过一整段视频。
    const VIDEO_ONLY_STALL_MS = 20000;
    const CLICK_COOLDOWN_MS = 2500;      // 同类点击冷却，避免每轮重复点
    const RATE_RETRY_MS = 8000;          // 倍速设置多久未生效就提示一次
    const CORRECT_ANSWER_WAIT_MS = 6000; // 提交后等待"正确答案"渲染
    const NAV_WAIT_MS = 10000;           // 翻页后等待题目变化的超时
    const MAX_QUESTIONS_PER_RUN = 300;   // 单次流程最多处理多少题（读不到页码时的死循环保护）
    const QUESTION_BANK_KEY = 'XUETANGX_QUESTION_BANK';
    const SETTINGS_KEY = 'XUETANGX_SETTINGS';
    // 参考资料库单独存一个 key：切片后可能上百 KB，混进设置里会让每次 getSettings 都变慢
    const REFERENCE_KEY = 'XUETANGX_REFERENCE';

    // ---- 参考资料检索参数 ----
    const REF_CHUNK_CHARS = 420;      // 每片目标字数
    const REF_CHUNK_OVERLAP = 60;     // 相邻片重叠，避免答案正好被切断
    const REF_TOP_K = 8;              // 每题注入多少片（讲义单页很短，均值仅 ~125 字，4 片上下文嫌少）
    const REF_MAX_CHARS = 3500;       // 注入提示词的参考资料总字数上限
    const REF_MIN_RATIO = 0.45;       // 低于最佳片得分 * 该比例的资料片直接丢弃（降噪）

    // ---- 视觉识图参数 ----
    // fetch 会被 CORS 拦、canvas 因图片跨域被 taint（toDataURL 抛 SecurityError），
    // 所以只能走 GM_xmlhttpRequest 取 arraybuffer 再自己转 base64。
    const VISION_MAX_IMAGES = 4;      // 单题最多带几张图
    const VISION_MAX_IMAGE_BYTES = 3 * 1024 * 1024;   // 单图体积上限，防止把接口请求撑爆

    // AI 默认路由：官方 DeepSeek 接口 + deepseek-flash 模型。
    // 模型名必须是接口实际支持的名称：官方接口只认 SUPPORTED_AI_MODELS 里列出的名字，其它会直接返回 400。
    const DEFAULT_AI_API_URL = 'https://api.deepseek.com/v1/chat/completions';
    const DEFAULT_AI_MODEL = 'deepseek-flash';
    const SUPPORTED_AI_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
    // 历史/写错的默认模型名：只要存档里是这些值（且地址仍是官方地址），就自动纠正为新默认模型
    const LEGACY_AI_MODELS = ['deepseek-chat', 'deepseek-v4.1-flash'];

    // 接口重试：DeepSeek 会返回 503 "Service is too busy"（临时过载），
    // 对 5xx / 429 / 408 / 网络错误做指数退避重试，避免一遇非 2xx 就白白浪费一整道题。
    const AI_MAX_RETRIES = 3;
    const AI_RETRY_BASE_MS = 1500;

    // 默认配置：1 倍速、题库作答、不自动翻页；「选中选项后自动提交」默认开启（可在面板关掉）。
    // 注意它只对"用户/脚本真的动过手"的题目生效（见 autoSubmitTick），不会一进页面就交卷。
    const DEFAULT_SETTINGS = {
        playbackRate: 1,      // 1 / 1.25 / 1.5 / 2
        answerMode: 'bank',   // 'bank' | 'ai'
        autoNext: false,      // 是否允许自动翻到下一单元（默认关闭，防止跳过未完成单元）
        autoSubmitOnSelect: true,   // 选中选项后自动点「提交」（提交后不能改答案，谨慎开启）
        panelPos: null,       // 面板位置 { x, y }，拖动后记忆；null = 默认右下角
        aiApiUrl: DEFAULT_AI_API_URL,
        aiApiKey: '',
        aiModel: DEFAULT_AI_MODEL,
        aiSaveToBank: false,  // AI 作答成功后是否把答案写回本地题库
        refEnabled: true,     // 是否把「参考资料库」检索到的片段注入提示词
        visionEnabled: true   // 是否把题干/选项里的图片交给多模态模型识别
    };

    function getSettings() {
        let saved = null;
        try { saved = GM_getValue(SETTINGS_KEY, null); } catch (e) { saved = null; }
        if (!saved || typeof saved !== 'object') return Object.assign({}, DEFAULT_SETTINGS);
        const merged = Object.assign({}, DEFAULT_SETTINGS, saved);
        // 空 / 纯空白的模型名一律回落默认值，避免把空字符串当模型名发出去（接口同样会 400）
        merged.aiModel = String(merged.aiModel || '').trim() || DEFAULT_AI_MODEL;
        // 旧默认值迁移：仅当"模型是历史默认/写错的名字 + 地址仍是官方 DeepSeek 地址"时才纠正为新默认模型；
        // 用户手动填过的自定义模型或中转地址一律保持原样，不会被覆盖。
        if (LEGACY_AI_MODELS.includes(merged.aiModel) &&
            String(merged.aiApiUrl || '').trim() === DEFAULT_AI_API_URL) {
            merged.aiModel = DEFAULT_AI_MODEL;
        }
        return merged;
    }

    function saveSettings(patch) {
        const next = Object.assign({}, getSettings(), patch);
        try { GM_setValue(SETTINGS_KEY, next); }
        catch (e) { console.error('[助手] 设置写入失败', e); }
        return next;
    }

    // ==================== 全局状态 ====================
    // 刷课任务与答题任务使用各自独立的锁，互不阻塞
    let videoTask = null;
    let answerTaskRunning = false;
    const BUSY_IDS = ['auto-extract-btn', 'auto-answer-btn', 'answer-from-bank-btn', 'return-first-btn', 'auto-video-btn'];

    // ==================== 样式 ====================
    GM_addStyle(`
        #control-panel { position: fixed; bottom: 20px; right: 20px; z-index: 2147483000; display: flex; flex-direction: column; gap: 10px; background: rgba(255,255,255,0.92); padding: 10px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); width: 210px; max-height: 80vh; overflow-y: auto; font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif; scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.30) transparent; }
        /* 面板内容比可视区高时必须能看出来"下面还有东西"：把滚动条做成常显的细条，
           否则 Windows 覆盖式滚动条平时不可见，底部的「返回第一题 / 清空本地题库」等按钮会被当成"不见了"。 */
        #control-panel::-webkit-scrollbar { width: 8px; }
        #control-panel::-webkit-scrollbar-track { background: transparent; }
        #control-panel::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.28); border-radius: 4px; }
        #control-panel::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.45); }
        #panel-drag-handle { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 6px; background: #f1f3f5; border-radius: 6px; cursor: move; cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; }
        #panel-drag-handle:active { cursor: grabbing; }
        #panel-drag-handle .panel-title { font-size: 12px; font-weight: bold; color: #444; pointer-events: none; }
        #panel-drag-handle .panel-grip { font-size: 12px; color: #999; letter-spacing: 1px; pointer-events: none; }
        #control-panel.dragging { box-shadow: 0 10px 26px rgba(0,0,0,0.35); opacity: 0.97; }
        #control-panel.xt-dragging-frozen { outline: 2px dashed #dc3545; }
        body.xt-panel-dragging, body.xt-panel-dragging * { user-select: none !important; -webkit-user-select: none !important; }
        .extractor-btn { background-color: #007bff; color: white; padding: 10px 15px; border: none; border-radius: 5px; cursor: pointer; font-size: 14px; opacity: 0.9; transition: all 0.2s ease; width: 100%; text-align: center; }
        .extractor-btn:hover { opacity: 1; }
        #auto-video-btn { background-color: #5856D6; }
        #auto-extract-btn { background-color: #28a745; }
        #auto-answer-btn { background-color: #ff6347; }
        #answer-from-bank-btn { background-color: #17a2b8; }
        #return-first-btn { background-color: #6c757d; }
        #clear-bank-btn { background-color: #f0ad4e; }
        .extractor-btn:disabled { background-color: #ccc; cursor: not-allowed; opacity: 1; }
        .extractor-select, .extractor-input { width: 100%; padding: 6px; border: 1px solid #ccc; border-radius: 5px; font-size: 13px; box-sizing: border-box; background: #fff; color: #333; }
        .panel-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #333; }
        .panel-field.checkbox-field { flex-direction: row; align-items: center; gap: 6px; }
        .panel-field.checkbox-field input { margin: 0; }
        .panel-details { font-size: 12px; color: #333; }
        .panel-details summary { cursor: pointer; margin-bottom: 6px; font-weight: bold; }
        .panel-details .extractor-input { margin-bottom: 6px; }
        .panel-hint { font-size: 11px; color: #888; line-height: 1.4; }
        #clear-ref-btn { background-color: #f0ad4e; }
        #ref-file-input { font-size: 11px; padding: 4px; }
        #ref-status { margin-bottom: 6px; }
        #result-modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); z-index: 2147483600; display: flex; justify-content: center; align-items: center; }
        #result-modal-content { position: relative; background: white; padding: 25px; border-radius: 8px; width: 80%; max-width: 800px; height: 80%; display: flex; flex-direction: column; box-shadow: 0 5px 20px rgba(0,0,0,0.3); }
        #result-textarea { flex-grow: 1; width: 100%; margin-top: 15px; font-family: monospace; font-size: 13px; border: 1px solid #ccc; border-radius: 4px; padding: 10px; box-sizing: border-box; resize: none; }
        #modal-close-btn { position: absolute; top: 15px; right: 20px; font-size: 28px; font-weight: bold; color: #888; cursor: pointer; line-height: 1; }
        #modal-close-btn:hover { color: #000; }
        .modal-btn { padding: 8px 15px; border: none; border-radius: 5px; cursor: pointer; margin-right: 10px; background-color: #007bff; color: white; }
        #modal-copy-btn { background-color: #28a745; }
        #modal-export-btn { background-color: #17a2b8; }
        #xt-toast-box { position: fixed; top: 16px; right: 16px; z-index: 2147483601; display: flex; flex-direction: column; gap: 8px; max-width: 320px; }
        .xt-toast { background: rgba(33,33,33,0.92); color: #fff; padding: 10px 14px; border-radius: 6px; font-size: 13px; line-height: 1.45; box-shadow: 0 4px 12px rgba(0,0,0,0.25); font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif; word-break: break-word; }
        .xt-toast.warn { background: rgba(196,120,0,0.95); }
        .xt-toast.error { background: rgba(190,40,40,0.95); }
        .xt-toast.success { background: rgba(30,140,70,0.95); }
    `);

    // ==================== 提示 / 忙碌状态 ====================
    function toast(message, type = 'info', duration = 4000) {
        let box = document.getElementById('xt-toast-box');
        if (!box) {
            box = document.createElement('div');
            box.id = 'xt-toast-box';
            box.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483601;display:flex;flex-direction:column;gap:8px;max-width:320px;';
            getMountRoot().appendChild(box);
        }
        const item = document.createElement('div');
        item.className = 'xt-toast' + (type && type !== 'info' ? ' ' + type : '');
        item.innerText = String(message);
        box.appendChild(item);
        setTimeout(() => { if (item.parentNode) item.parentNode.removeChild(item); }, duration);
        return item;
    }

    function syncBusyState() {
        const answerBusy = answerTaskRunning;
        const videoBusy = !!videoTask;
        BUSY_IDS.forEach(id => {
            const btn = document.getElementById(id);
            if (!btn) return;
            if (id === 'auto-video-btn') btn.disabled = answerBusy;              // 答题时不允许开刷课
            else btn.disabled = answerBusy || videoBusy;                          // 任一任务运行中都禁用
        });
    }

    // ==================== 通用 DOM 工具 ====================
    function q(selector, root) {
        try { return (root || document).querySelector(selector); } catch (e) { return null; }
    }

    function qa(selector, root) {
        try { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
        catch (e) { return []; }
    }

    function isVisible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    // ---- 页面世界点击通道：让合成点击真的被站点受理 ----
    // 实测事实：学堂在线「提交 / 下一题 / 确定」这类按钮的处理器只认 detail 非 0 的 MouseEvent，
    //   而 Tampermonkey 沙箱派发出去的事件会被"净化"—— 脚本里传 detail:1 / buttons:1，
    //   页面世界收到的是 detail:0 / buttons:0（沙箱内构造本身正常，被改的是 dispatchEvent 这一环）。
    //   于是表现为「选中选项后脚本点了提交，按钮文案与剩余次数却毫无变化」。
    // 其它路径都验证过且不可行：unsafeWindow.MouseEvent 同样被代理；用 unsafeWindow 的原生
    //   Node.prototype.dispatchEvent 会抛错（沙箱元素是代理、不是真节点）；
    //   注入页面世界的函数沙箱里读不到（typeof undefined）。
    // 方案：唯一稳定的跨界信道是 DOM 本身 —— 脚本把「请点 <label> 按钮」写进 <html> 的属性，
    //   注入页面世界的小助手用 MutationObserver 接到请求后以原生 MouseEvent 点击（detail 完整），
    //   再把结果（clicked / no-button / err）写回另一个属性，供脚本回读与排障。
    const XT_SUBMIT_REQ_ATTR = 'data-xt-submit-req';
    const XT_SUBMIT_RES_ATTR = 'data-xt-submit-res';

    function ensureSubmitHelper() {
        try {
            if (window.__xtSubmitHelperInjected) return true;
            window.__xtSubmitHelperInjected = true;
            const code = '(function(){if(window.__xtSubmitHelperReady)return;window.__xtSubmitHelperReady=1;'
                + 'var REQ="' + XT_SUBMIT_REQ_ATTR + '",RES="' + XT_SUBMIT_RES_ATTR + '";'
                + 'function findBtn(label){var bs=document.querySelectorAll("button,a,[role=\\"button\\"],.btn");'
                + 'for(var i=0;i<bs.length;i++){var b=bs[i],r=b.getBoundingClientRect(),s=getComputedStyle(b);'
                + 'if(r.width<=0||r.height<=0||s.display==="none"||s.visibility==="hidden")continue;'
                + 'if(b.disabled===true||b.getAttribute("aria-disabled")==="true")continue;'
                + 'if(/disable/.test(String(b.className)))continue;'
                + 'var t=(b.innerText||"").trim();if(label&&t.indexOf(label)<0)continue;'
                + 'if(!label&&!/提交|交卷|下一题|下一页|确定|确认|跳过/.test(t))continue;return b;}return null;}'
                + 'new MutationObserver(function(){var v=document.documentElement.getAttribute(REQ);if(!v)return;'
                + 'document.documentElement.removeAttribute(REQ);'
                + 'var label=String(v).split("#")[0];var b=findBtn(label);'
                + 'if(!b){document.documentElement.setAttribute(RES,"no-button:"+label);return;}'
                + 'try{b.focus&&b.focus();var p={bubbles:true,cancelable:true,composed:true,view:window,detail:1,button:0,buttons:1};'
                + 'b.dispatchEvent(new MouseEvent("mousedown",p));b.dispatchEvent(new MouseEvent("mouseup",p));'
                + 'b.dispatchEvent(new MouseEvent("click",p));'
                + 'document.documentElement.setAttribute(RES,"clicked:"+label);}'
                + 'catch(e){document.documentElement.setAttribute(RES,"err:"+e.message);}})'
                + '.observe(document.documentElement,{attributes:true,attributeFilter:[REQ]});})();';
            const s = document.createElement('script');
            s.textContent = code;
            (document.head || document.documentElement).appendChild(s);
            s.remove();
            return true;
        } catch (e) { return false; }
    }

    // 请求页面世界点击某个按钮。label 为空时由助手自己按「提交/交卷/下一题…」挑一个。
    function clickSubmitViaPageWorld(label) {
        try {
            if (!ensureSubmitHelper()) return false;
            const root = document.documentElement;
            root.removeAttribute(XT_SUBMIT_RES_ATTR);
            // 末尾带时间戳：保证属性值每次都变，MutationObserver 才会再次触发
            root.setAttribute(XT_SUBMIT_REQ_ATTR, String(label || '') + '#' + Date.now());
            const written = root.getAttribute(XT_SUBMIT_REQ_ATTR) !== null;   // 回读体检：属性真的写进去了才算发出去
            if (!window.__xtSubmitChannelLogged) {
                window.__xtSubmitChannelLogged = true;
                console.log('[助手] 按钮点击已改走页面世界通道（原生事件，detail 不会被沙箱抹掉）。');
            }
            return written;
        } catch (e) { return false; }
    }

    // 页面世界通道的回执（clicked / no-button / err:xxx），仅用于排障日志
    function submitChannelResult() {
        try { return document.documentElement.getAttribute(XT_SUBMIT_RES_ATTR) || 'n/a'; } catch (e) { return 'n/a'; }
    }

    function dispatchClick(el) {
        if (!el) return false;
        const params = {
            bubbles: true,
            cancelable: true,
            composed: true,      // 元素在 Shadow DOM 里也能穿透
            view: window,
            detail: 1,           // ← 关键：真实单击的 detail 为 1
            button: 0,
            buttons: 1
        };
        try {
            if (typeof el.focus === 'function' && el.tagName !== 'DIV') el.focus();
            // ① 会校验 detail 的按钮（提交/交卷、页内「下一题/下一页」、弹窗「确定/确认/跳过」）：
            //    交给页面世界通道用原生事件点击（沙箱派发会把 detail 抹成 0，站点直接忽略）
            const label = String((el.innerText || el.textContent || '') || '').trim();
            const wantPW = /(提交|交卷|下一题|下一页|确定|确认|跳过)/.test(label);
            if (wantPW && clickSubmitViaPageWorld(label)) {
                return true;
            }
            // ② 其它元素（选项 / 翻页箭头等）：沙箱派发即可，站点不校验 detail
            el.dispatchEvent(new MouseEvent('mousedown', params));
            el.dispatchEvent(new MouseEvent('mouseup', params));
            el.dispatchEvent(new MouseEvent('click', params));
            return true;
        } catch (e) {
            try { el.click(); return true; } catch (e2) { console.error('[助手] 点击失败', e2); return false; }
        }
    }

    // ==================== 挂载点 ====================
    // 关键：面板挂到 <html> 而不是 <body>。
    // 若 body/中间容器带 transform / filter / perspective，会成为 position:fixed 的包含块，
    // 导致 fixed 定位相对该容器计算 —— 表现就是"样式变了但位置不动/乱动"。
    function getMountRoot() {
        return document.documentElement || document.body;
    }

    // ==================== 面板拖动 ====================
    let dragState = null;   // { panel, handle, pointerId, startX, startY, startLeft, startTop, lastMoveAt }

    function clamp(n, min, max) {
        if (max < min) return min;
        return Math.min(Math.max(n, min), max);
    }

    function getViewportSize() {
        const docEl = document.documentElement || {};
        const body = document.body || {};
        const winW = window.innerWidth || docEl.clientWidth || body.clientWidth || 1024;
        const winH = window.innerHeight || docEl.clientHeight || body.clientHeight || 768;
        return { winW, winH };
    }

    // 把面板放到 (x, y)：至少保留 60px 在视口内，保证标题栏永远抓得回来
    function applyPanelPos(panel, x, y) {
        if (!panel) return;
        const rect = panel.getBoundingClientRect ? panel.getBoundingClientRect() : { width: 210, height: 300 };
        const size = getViewportSize();
        const width = rect.width || 210;
        const x2 = clamp(x, -(width - 60), size.winW - 60);
        const y2 = clamp(y, 0, Math.max(0, size.winH - 40));
        panel.style.setProperty('position', 'fixed', 'important');
        panel.style.setProperty('left', x2 + 'px', 'important');
        panel.style.setProperty('top', y2 + 'px', 'important');
        panel.style.setProperty('right', 'auto', 'important');
        panel.style.setProperty('bottom', 'auto', 'important');
    }

    function currentPanelPos(panel) {
        const rect = panel.getBoundingClientRect();
        return { x: rect.left, y: rect.top };
    }

    function beginPanelDrag(panel, handle, clientX, clientY) {
        if (!panel || dragState) return;
        const rect = panel.getBoundingClientRect();
        dragState = {
            panel: panel,
            handle: handle,
            pointerId: null,
            startX: clientX,
            startY: clientY,
            startLeft: rect.left,
            startTop: rect.top,
            lastMoveAt: 0
        };
        panel.classList.add('dragging');
        if (document.body && document.body.classList) document.body.classList.add('xt-panel-dragging');
    }

    // 拖动位移改用"位置增量"而不是"鼠标绝对位置 - 手柄偏移"：
    // 这样即使父级带 transform/zoom 导致 rect 与 style 坐标系不一致，面板也会跟着鼠标动，不会卡住。
    function onPanelDragMove(event) {
        if (!dragState) return;
        const ev = event || {};
        if (ev.buttons !== undefined && ev.buttons === 0) { if (typeof ev.clientX !== 'number') { onPanelDragEnd(); return; } }
        if (typeof ev.clientX !== 'number' || typeof ev.clientY !== 'number') return;
        const at = typeof ev.timeStamp === 'number' ? ev.timeStamp : 0;
        if (at && dragState.lastMoveAt && at === dragState.lastMoveAt) return;   // 双通道去重
        dragState.lastMoveAt = at;
        applyPanelPos(
            dragState.panel,
            dragState.startLeft + (ev.clientX - dragState.startX),
            dragState.startTop + (ev.clientY - dragState.startY)
        );
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
    }

    function onPanelDragEnd() {
        if (!dragState) return;
        const state = dragState;
        dragState = null;
        const panel = state.panel;
        const handle = state.handle;
        panel.classList.remove('dragging');
        if (document.body && document.body.classList) document.body.classList.remove('xt-panel-dragging');
        detachDragChannels(handle);
        if (state.pointerId !== null && handle && handle.releasePointerCapture) {
            try { handle.releasePointerCapture(state.pointerId); } catch (e) { /* ignore */ }
        }
        try {
            const rect = panel.getBoundingClientRect();
            const styleLeft = parseFloat(panel.style.left);
            const moved = Math.abs(rect.left - state.startLeft) > 1 || Math.abs(rect.top - state.startTop) > 1;
            // 样式写了但视觉位置没变 = 定位被页面布局因素吃掉（多半是父级 transform 或样式覆盖）
            if (isNaN(styleLeft)) {
                console.warn('[助手] 面板位置样式未能写入，拖动无效', panel.getAttribute && panel.getAttribute('style'));
                panel.classList.add('xt-dragging-frozen');
                toast('拖动无效：面板位置样式未能写入页面（多半被站点样式覆盖）。', 'error', 8000);
            } else if (!moved) {
                panel.classList.add('xt-dragging-frozen');
                toast('拖动无效：位置样式已写入但画面未变化（疑似父级 transform / 样式覆盖）。', 'error', 8000);
            } else {
                panel.classList.remove('xt-dragging-frozen');
                saveSettings({ panelPos: { x: Math.round(rect.left), y: Math.round(rect.top) } });
                console.log(`[助手] 面板已移动到 (${Math.round(rect.left)}, ${Math.round(rect.top)})`);
            }
        } catch (e) { console.warn('[助手] 面板位置保存失败', e); }
    }

    function attachDragChannels(handle) {
        // 双通道：
        //  A) 手柄自身（bubble + capture）—— 页面若在 window/document 捕获阶段 stopPropagation 也拦不住
        //  B) window 捕获阶段 —— 鼠标移出手柄/面板后仍能收到（指针捕获失效时的兜底）
        // 事件重复由 timeStamp 去重。
        handle.addEventListener('pointermove', onPanelDragMove, true);
        handle.addEventListener('pointermove', onPanelDragMove, false);
        handle.addEventListener('pointerup', onPanelDragEnd, true);
        handle.addEventListener('pointerup', onPanelDragEnd, false);
        handle.addEventListener('pointercancel', onPanelDragEnd, true);
        handle.addEventListener('mousemove', onPanelDragMove, true);
        handle.addEventListener('mousemove', onPanelDragMove, false);
        handle.addEventListener('mouseup', onPanelDragEnd, true);
        handle.addEventListener('mouseup', onPanelDragEnd, false);
        window.addEventListener('pointermove', onPanelDragMove, true);
        window.addEventListener('pointerup', onPanelDragEnd, true);
        window.addEventListener('pointercancel', onPanelDragEnd, true);
        window.addEventListener('mousemove', onPanelDragMove, true);
        window.addEventListener('mouseup', onPanelDragEnd, true);
        window.addEventListener('blur', onPanelDragEnd, true);
    }

    function detachDragChannels(handle) {
        if (handle) {
            handle.removeEventListener('pointermove', onPanelDragMove, true);
            handle.removeEventListener('pointermove', onPanelDragMove, false);
            handle.removeEventListener('pointerup', onPanelDragEnd, true);
            handle.removeEventListener('pointerup', onPanelDragEnd, false);
            handle.removeEventListener('pointercancel', onPanelDragEnd, true);
            handle.removeEventListener('mousemove', onPanelDragMove, true);
            handle.removeEventListener('mousemove', onPanelDragMove, false);
            handle.removeEventListener('mouseup', onPanelDragEnd, true);
            handle.removeEventListener('mouseup', onPanelDragEnd, false);
        }
        window.removeEventListener('pointermove', onPanelDragMove, true);
        window.removeEventListener('pointerup', onPanelDragEnd, true);
        window.removeEventListener('pointercancel', onPanelDragEnd, true);
        window.removeEventListener('mousemove', onPanelDragMove, true);
        window.removeEventListener('mouseup', onPanelDragEnd, true);
        window.removeEventListener('blur', onPanelDragEnd, true);
    }

    function attachPanelDrag(panel, handle) {
        const start = (event) => {
            if (event.button !== undefined && event.button !== 0) return;   // 只响应左键
            if (dragState) return;
            if (typeof event.preventDefault === 'function') event.preventDefault();   // 阻止选中文字/原生拖拽
            beginPanelDrag(panel, handle, event.clientX, event.clientY);

            if (typeof event.pointerId === 'number') {
                dragState.pointerId = event.pointerId;
                try { if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
            }
            attachDragChannels(handle);
        };
        if (window.PointerEvent) handle.addEventListener('pointerdown', start);
        handle.addEventListener('mousedown', start);   // 兼容通道：两者由 dragState 去重

        // 双击标题栏恢复默认右下角
        handle.addEventListener('dblclick', (event) => {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            resetPanelPos(panel);
        });
    }

    function resetPanelPos(panel) {
        panel.style.setProperty('right', '20px', 'important');
        panel.style.setProperty('bottom', '20px', 'important');
        panel.style.setProperty('left', 'auto', 'important');
        panel.style.setProperty('top', 'auto', 'important');
        panel.classList.remove('xt-dragging-frozen');
        saveSettings({ panelPos: null });
        console.log('[助手] 面板已复位到右下角');
    }

    // 视口尺寸变化后把面板拉回可视范围
    function syncPanelClamp() {
        const panel = document.getElementById('control-panel');
        if (!panel) return;
        if (!getSettings().panelPos) return;   // 仍用默认右下角定位时无需处理
        const pos = currentPanelPos(panel);
        applyPanelPos(panel, pos.x, pos.y);
    }

    // 元素描述：正常流程（静音失败时打控制条诊断日志）要用，保留
    function describeElement(el) {
        if (!el) return null;
        const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        return {
            tag: el.tagName || String(el),
            id: el.id || '',
            cls: typeof el.className === 'string' ? el.className : '',
            rect: rect ? { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
            inlineStyle: el.getAttribute ? el.getAttribute('style') : null,
            computed: cs ? { position: cs.position, left: cs.left, top: cs.top, right: cs.right, bottom: cs.bottom, zIndex: cs.zIndex, transform: cs.transform, zoom: cs.zoom, display: cs.display, visibility: cs.visibility } : null
        };
    }

    // ==================== 答题页控件定位（提交按钮 / 下一题箭头） ====================
    // 提交按钮的文案可能是"提交（剩余1次）"，只按 ^提交$ 精确匹配会漏掉；
    // 翻页除了页脚 .tabbar 的左右箭头，还可能是页面里一个单独的 ">" 按钮。
    const SUBMIT_EXACT_RE = /^(提交|提交答案|交卷|提交试卷)$/;
    const SUBMIT_LEFT_TIMES_RE = /^提交\s*[（(]\s*剩余\s*\d*\s*次?\s*[）)]$/;
    const SUBMIT_BLOCK_RE = /暂存|保存|草稿|重置|清空|删除|退出|取消|返回|上一题/;
    const ARROW_NEXT_TEXT = /^[>›〉»→▶⟩]$/;
    const NEXT_BTN_SELECTORS = [
        '.tabbar i.iconfont.right',
        '.tabbar .right',
        '.tabbar i.right',
        '.tabbar [class*="arrow-right"]',
        '[class*="arrow-right"]',
        '[class*="right-arrow"]',
        '.el-icon-arrow-right',
        '.anticon-right',
        '[title*="下一题"]',
        '[title*="下一页"]',
        '[aria-label*="下一题"]'
    ];

    // 统一的"不可用"判断：disabled / aria-disabled / 类名里的 disabled|disable|unselect|forbid
    function isDisabledEl(el) {
        if (!el) return true;
        if (el.disabled === true) return true;
        try {
            if (el.getAttribute && (el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true')) return true;
        } catch (e) { /* ignore */ }
        const cls = typeof el.className === 'string' ? el.className : '';
        // 逐 token 判断，而不是整串正则：
        //  - 站点用的禁用标记是 `disable`（少个 d），只认 `disabled` 会把禁用按钮当成可点；
        //  - `unselectable` 只表示"文字不可选中"（页脚那个可点的右箭头也带它），只有 `unselect` 才是禁用；
        //  - 还要认组件库常用的 `is-disabled` / `btn-disabled` / `xt-disabled` 这类"前缀 + disabled"写法。
        return String(cls).split(/\s+/).filter(Boolean).some((t) => {
            if (/unselectable/i.test(t)) return false;                  // 只表示"文字不可选中"，不是禁用
            if (/^(is|btn|xt|el|ant)[-_]/i.test(t)) return /disabled?$/i.test(t);
            return /^(disabled?|unselect|forbid)$/i.test(t);
        });
    }

    function buttonText(el) {
        if (!el) return '';
        return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // 提交按钮：文案按「提交(剩余N次) / 提交 / 交卷」优先，排除暂存 / 保存 / 重置 / 上一题等危险按钮。
    // 候选只收真正可点的元素（BUTTON / A / role=button / .btn）：站点结构是
    //   <span class="el-popover__reference-wrapper"><button class="btn">提交<span>(剩余1次)</span></button></span>，
    //   外层 span 的 innerText 同样是"提交(剩余1次)"，点到包裹层不会触发按钮自己的 Vue 事件。
    // allowSoftDisabled：有些页面版本把 `disable` 类一直挂在按钮上（只是样式、点得动），
    //   严格判据会把它过滤掉、导致永远交不上去；开启后仍排除真正的 disabled / aria-disabled，
    //   但允许带 disable 类的按钮作为兜底候选。
    function findSubmitButton(options) {
        const allowSoftDisabled = !!(options && options.allowSoftDisabled);
        const scope = q('.answerCon') || q('.exam-main') || document.body;
        const rankOf = (text) => {
            if (SUBMIT_BLOCK_RE.test(text)) return -1;
            if (SUBMIT_EXACT_RE.test(text)) return 0;
            if (SUBMIT_LEFT_TIMES_RE.test(text)) return 1;
            if (/^提交/.test(text)) return 2;
            if (/提交|交卷/.test(text)) return 3;
            return -1;
        };
        const hardDisabled = (el) => {
            if (el.disabled === true) return true;
            try {
                return !!(el.getAttribute && (el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true'));
            } catch (e) { return false; }
        };
        const collect = (root) => qa('button, a, [role="button"], .btn, .el-button', root)
            .filter((el) => isVisible(el) && (allowSoftDisabled ? !hardDisabled(el) : !isDisabledEl(el)))
            .map((el) => {
                const raw = rankOf(buttonText(el));
                const clickableOwn = (el.tagName === 'BUTTON' || el.tagName === 'A' ||
                    (el.getAttribute && el.getAttribute('role') === 'button')) ? 0 : 0.5;
                return { el: el, rank: raw + clickableOwn, raw: raw };
            })
            .filter((it) => it.raw >= 0);
        let hits = collect(scope);
        if (hits.length === 0 && scope !== document.body) hits = collect(document.body);
        hits.sort((a, b) => a.rank - b.rank);
        return hits.length > 0 ? hits[0].el : null;
    }

    // 在页码指示器（"7/7"）附近找"向右箭头"——页面结构通常是 < i.left > 7/7 < i.right >
    function findArrowBeside(el) {
        const isArrowish = (node) => {
            if (!node || !isVisible(node) || isDisabledEl(node)) return false;
            if (node.querySelector && node.querySelector('button, a, input, textarea')) return false;
            const cls = typeof node.className === 'string' ? node.className : '';
            const title = String((node.getAttribute && (node.getAttribute('title') || node.getAttribute('aria-label'))) || '');
            if (/下一[题页]/.test(title)) return true;
            if (ARROW_NEXT_TEXT.test(buttonText(node))) return true;          // 文字就是 ">"
            return /right|next|forward/i.test(cls) && !/left|prev|back/i.test(cls);
        };
        let node = el;
        for (let depth = 0; node && depth < 4; depth++) {
            const parent = node.parentElement;
            if (!parent) break;
            const kids = Array.prototype.slice.call(parent.children);
            const selfIndex = kids.indexOf(node);
            for (let i = selfIndex + 1; i < kids.length; i++) { if (isArrowish(kids[i])) return kids[i]; }   // 页码右侧优先
            for (let i = 0; i < selfIndex; i++) { if (isArrowish(kids[i])) return kids[i]; }
            node = parent;
        }
        return null;
    }

    // 新版练习页：点「提交(剩余N次)」后同一个按钮会就地变成「下一题」（DOM 位置不变、去掉 disable），
    // 这是站点的正式动线，故优先按文案找它，找不到再退回页脚 ">" 箭头。文案兼容「下一题/下一页」
    // 与带箭头尾巴的写法；注意不要匹配「下一单元/下一节」（那是刷课翻页）与「上一题/上一页」。
    const INLINE_NEXT_RE = /^\s*(下一[题页]|继续下一[题页])\s*[>›〉»→▶⟩]?\s*$/;

    function findInlineNextQuestionButton() {
        const candidates = qa('button, a, [role="button"], .btn, .el-button, span, div')
            .filter((el) => isVisible(el) && !isDisabledEl(el) && INLINE_NEXT_RE.test(buttonText(el)));
        if (candidates.length === 0) return null;
        // 取真正可点的那个：外层 div/span 往往只是包裹层，嵌套时 button/a 在文档序里更靠后
        return candidates.find((el) => el.tagName === 'BUTTON' || el.tagName === 'A' ||
            (el.getAttribute && el.getAttribute('role') === 'button')) || candidates[candidates.length - 1];
    }

    // "下一题"按钮：先按类名/title，再看页码旁边的箭头，最后兜底找"文字就是 > 的小元素"
    function findNextQuestionButton() {
        const inline = findInlineNextQuestionButton();
        if (inline) return inline;
        for (const sel of NEXT_BTN_SELECTORS) {
            const hit = qa(sel).find((el) => isVisible(el) && !isDisabledEl(el));
            if (hit) return hit;
        }
        const pageEl = findPageIndicatorEl();
        if (pageEl) {
            const beside = findArrowBeside(pageEl);
            if (beside) return beside;
        }
        const arrows = qa('button, a, i, span, em, b, div').filter((el) => {
            if (!isVisible(el) || isDisabledEl(el)) return false;
            if (el.querySelector && el.querySelector('button, a, input, textarea')) return false;
            return ARROW_NEXT_TEXT.test(buttonText(el));
        });
        return arrows.length > 0 ? arrows[0] : null;
    }

    // ==================== 核心功能 1: 自动刷课 ====================
    function parseRateFromText(text) {
        if (!text) return null;
        const match = String(text).match(/(\d+(?:\.\d+)?)/);
        return match ? parseFloat(match[1]) : null;
    }

    function setPlaybackRate(rate, state) {
        // 倍速菜单/当前倍速文本也可能在 iframe 或 Shadow DOM 里，统一用 qAny 查
        const list = qAny('.xt_video_player_common_list');
        const currentEl = qAny('.xt_video_player_speed_show_box') || findRateTextEl();

        // 满足以下任一条件即视为菜单已展开、可安全点选项：
        // 1) 本地标记菜单已打开; 2) 列表可见; 3) 列表里已有多个倍速项
        const listChildren = list ? list.children.length : 0;
        const menuOpen = state.rateMenuOpen || isVisible(list) || listChildren > 1;

        if (!menuOpen) {
            const opener = currentEl || qAny('.xt_video_player_common_speed') || qAny('.xt_video_player_common_speed_box');
            if (!opener) return false;
            if (Date.now() - (state.rateOpenedAt || 0) > CLICK_COOLDOWN_MS) {
                console.log(`刷课: 展开倍速菜单, 目标 ${rate}x`);
                dispatchClick(opener);
                state.rateOpenedAt = Date.now();
                state.rateMenuOpen = true;
            }
            return false;   // 下一轮巡检再真正选中选项
        }

        if (!list || listChildren === 0) return false;

        const currentRate = currentEl ? parseRateFromText(currentEl.textContent) : null;
        if (currentRate !== null && Math.abs(currentRate - rate) < 0.001) {
            state.rateMenuOpen = false;
            state.rateWarned = false;
            return true;    // 已是目标倍速
        }

        let target = null;
        Array.prototype.forEach.call(list.children, (li) => {
            if (target) return;
            const r = parseRateFromText(li.textContent);
            if (r !== null && Math.abs(r - rate) < 0.001) target = li;
        });

        if (!target) {
            if (!state.rateWarned) {
                state.rateWarned = true;
                toast(`倍速菜单中没有找到 ${rate}x 选项，已保持平台当前倍速。`, 'warn');
                console.warn('[助手] 倍速选项缺失', list.innerText);
            }
            return false;
        }

        console.log(`刷课: 设置 ${rate}x 倍速`);
        dispatchClick(target);
        state.rateMenuOpen = false;
        state.rateWarned = false;
        return true;
    }

    // ==================== 播放器定位（顶层 document / 同源 iframe / Shadow DOM） ====================
    // 新版播放页会把播放器放进 iframe 或封装成 Shadow DOM，只在顶层 document 里查，video 和音量键都找不到。
    // 这里统一收集"可搜索的文档根"：顶层 document + 同源 iframe 的 contentDocument + 递归的 ShadowRoot
    // （跨域 iframe 拿不到 contentDocument，那种情况脚本无解，只能提示用户）。
    function collectPlayerRoots() {
        const roots = [document];
        const scan = (root, depth) => {
            if (!root || depth > 4) return;
            let frames = [];
            let all = [];
            try { frames = Array.prototype.slice.call(root.querySelectorAll('iframe')); } catch (e) { frames = []; }
            frames.forEach((f) => {
                let doc = null;
                try { doc = f.contentDocument; } catch (e) { doc = null; }
                if (doc && doc.querySelector && roots.indexOf(doc) === -1) { roots.push(doc); scan(doc, depth + 1); }
            });
            try { all = Array.prototype.slice.call(root.querySelectorAll('*')); } catch (e) { all = []; }
            all.forEach((el) => {
                if (el.shadowRoot && roots.indexOf(el.shadowRoot) === -1) { roots.push(el.shadowRoot); scan(el.shadowRoot, depth + 1); }
            });
        };
        scan(document, 0);
        // 让"真正含 <video> 的根"排在前面：页面里常有多个同源 iframe（如 AI 问答窗），
        // 先把播放器所在的文档排前，控件就不会被别处的同名元素抢先命中。
        const withVideo = [];
        const rest = [];
        roots.forEach((r) => {
            let has = false;
            try { has = !!r.querySelector('video'); } catch (e) { has = false; }
            (has ? withVideo : rest).push(r);
        });
        return withVideo.concat(rest);
    }

    // 根集合缓存：collectPlayerRoots 要遍历全文档，每轮巡检只算一次（1.5s 内复用）
    let playerRootsCache = { at: 0, roots: null };
    function getPlayerRoots(force) {
        const now = Date.now();
        if (force || !playerRootsCache.roots || now - playerRootsCache.at > 1500) {
            playerRootsCache = { at: now, roots: collectPlayerRoots() };
        }
        return playerRootsCache.roots;
    }

    // 在当前页所有可搜索根里查元素（顶层文档 → iframe 文档 → Shadow DOM）
    function qAny(selector) {
        const roots = getPlayerRoots();
        for (let i = 0; i < roots.length; i++) {
            let hit = null;
            try { hit = roots[i].querySelector(selector); } catch (e) { hit = null; }
            if (hit) return hit;
        }
        return null;
    }

    function qaAny(selector) {
        const roots = getPlayerRoots();
        const out = [];
        roots.forEach((r) => {
            try { out.push.apply(out, Array.prototype.slice.call(r.querySelectorAll(selector))); } catch (e) { /* ignore */ }
        });
        return out;
    }

    // video 元素同样可能在 iframe/Shadow DOM 里 —— 找不到它，后面的静音/播放全都会失效
    function findVideoEl() {
        const roots = getPlayerRoots();
        for (let i = 0; i < roots.length; i++) {
            let v = null;
            try { v = roots[i].querySelector('video'); } catch (e) { v = null; }
            if (v) return v;
        }
        return null;
    }

    function isPlayerMuted() {
        const video = findVideoEl();
        if (video && typeof video.muted === 'boolean') {
            // 有些播放器把真正的声音放在 volume 上（muted=false 但 volume=0 也是静音）
            if (video.muted) return true;
            if (typeof video.volume === 'number' && video.volume === 0) return true;
            return false;
        }
        // 读不到 video（跨域 iframe 等）时，退化成看播放器自己的状态标记
        return !!qAny('.xt_video_player_common_icon_muted') || volumeHostLooksMuted();
    }

    // Web Component 播放器的静音状态一般写在音量宿主的 class 或属性上
    // （如 xt_video_player_volume_muted / [muted]）。读不到 video.muted 时才用这条兜底。
    function volumeHostLooksMuted() {
        const host = qAny('xt-volumebutton') || qAny(MUTE_HOST_SEL);
        if (!host) return false;
        let attrs = '';
        try {
            attrs = ['muted', 'is-mute', 'isMute', 'volume', 'status', 'state']
                .map((n) => host.getAttribute && host.getAttribute(n))
                .filter(Boolean).join(' ');
        } catch (e) { attrs = ''; }
        const hint = elHintText(host) + ' ' + attrs;
        if (/unmute|no-?mute|有声/i.test(hint)) return false;
        return /muted|mute|静音/i.test(hint);
    }

    // 音量键是「切换」语义（单击静音、再单击恢复外放），所以候选按优先级排列，并排除滑条 / 进度条等
    //   "点了不会静音"的同名容器。选择器只是第一层：类名每版播放器都可能改，后面还有 SVG 图标、
    //   位置锚定等兜底。现场 DOM 里新版是 Web Component：
    //   <xt-volumebutton><xt-icon class="…common_icon"/>…，单击静音的处理器挂在里面的 <xt-icon> 上。
    const MUTE_BTN_SELECTORS = [
        '.xt_video_player_common_icon_muted',
        '.xt_video_player_common_icon_volume',
        '.xt_video_player_common_volume_icon',
        '.xt_video_player_common_icon_sound',
        'xt-volumebutton',
        '[class*="volume_button"]',
        '[class*="volume-button"]',
        '[class*="icon_mute"]',
        '[class*="icon_volume"]',
        '[class*="icon_voice"]',
        '[class*="icon_sound"]',
        '[class*="volume"]',
        '[class*="mute"]',
        '[class*="sound"]',
        '[class*="speaker"]',
        '[class*="yinliang"]'
    ];
    // 图标本身没有语义类名时，用"宿主容器里的子元素"定位（只在这些宿主内查找，避免误抓）
    const MUTE_HOST_SEL = 'xt-volumebutton, [class*="volume"], [class*="mute"], [class*="sound"], [class*="speaker"]';
    const MUTE_ICON_SEL = 'xt-icon, i, svg, [class*="common_icon"], [class*="icon_volume"], [class*="icon_mute"]';
    const MUTE_BTN_TITLE_SELECTORS = [
        '[title*="静音"]', '[title*="音量"]', '[title*="声音"]',
        '[aria-label*="静音"]', '[aria-label*="音量"]', '[aria-label*="声音"]',
        '[data-title*="静音"]', '[data-title*="音量"]'
    ];
    // 这些关键字出现的控件一定不是音量键（全屏/设置/清晰度/倍速/进度条/AI 等）
    const MUTE_NOT_HINT_RE = /full|fullscreen|expand|screen|setting|setup|clarity|definition|quality|speed|rate|progress|slider|track|barrage|danmaku|bullet|next|prev|play|pause|refresh|replay|loop/i;
    const MUTE_YES_HINT_RE = /mute|volume|voice|sound|audio|speaker|silent|静音|音量|声音/i;

    // ---- 唤醒播放器控制条 ----
    // 控制条收起时静音键 / 倍速菜单要么不在 DOM、要么 opacity:0，按可见性去找必然失败；脚本又没法移动
    // 真实光标，只能向播放器派发一串合成鼠标事件来"扰动"它：mouseover / mouseenter 负责"进入区域"，
    // mousemove / pointermove 负责"移动"（播放器多半监听后者），并在视频区域内左右各偏移 1px 发两次
    // —— 只发一次不动的事件，部分播放器会认为"没有真的移动"而忽略。
    function wakePlayerControls(state) {
        if (state) {
            const now = Date.now();
            if (now - (state.lastWakeAt || 0) < MUTE_WAKE_MIN_INTERVAL_MS) return false;   // 节流
            state.lastWakeAt = now;
        }
        const player = qAny('.xt_video_player') || qAny('.xt_video_player_wrap') || qAny('.xt_video_player_common_pc') || findVideoEl();
        if (!player) return false;

        let rect = null;
        try { rect = player.getBoundingClientRect(); } catch (e) { rect = null; }
        const hasRect = !!(rect && rect.width > 0 && rect.height > 0);
        const x = Math.round(hasRect ? rect.left + rect.width / 2 : (window.innerWidth || 1000) / 2);
        const y = Math.round(hasRect ? rect.top + rect.height / 2 : (window.innerHeight || 600) / 2);

        const video = findVideoEl();
        const targets = [player];
        if (video && video !== player) targets.push(video);
        // 播放器可能把 mousemove 委托在它所在的那个文档上（iframe 文档 / Shadow Root 的宿主文档）
        getPlayerRoots().forEach((r) => {
            const doc = r.nodeType === 9 ? r : (r.ownerDocument || null);
            if (doc && targets.indexOf(doc) === -1) targets.push(doc);
        });

        targets.forEach((el) => {
            [-1, 1].forEach((dx) => {
                ['mouseover', 'mouseenter', 'mousemove', 'pointermove'].forEach((type) => {
                    try {
                        el.dispatchEvent(new MouseEvent(type, {
                            bubbles: true, cancelable: true, view: window,
                            clientX: x + dx, clientY: y
                        }));
                    } catch (e) { /* ignore */ }
                });
            });
        });
        // 顺便把"最后活动时间"往后推：部分播放器用页面级计时器来收起控制条，
        // 真实鼠标不动时我们每轮都扰动一下，控制条就不会在操作前又缩回去。
        return true;
    }

    const ICON_CHAR_RE = /[\uE000-\uF8FF\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF]/;   // 图标字体私用区/箭头/符号

    function elHintText(el) {
        if (!el) return '';
        let attrs = '';
        try {
            attrs = [el.getAttribute('title'), el.getAttribute('aria-label'), el.getAttribute('data-title')].filter(Boolean).join(' ');
        } catch (e) { attrs = ''; }
        return `${typeof el.className === 'string' ? el.className : ''} ${attrs} ${buttonText(el)}`;
    }

    // "像图标控件"：没文字，或只有图标字体/符号字符/数值读数。
    // 用来把 设置/标清 这类"文字控件"排除掉（它们不可能是音量键）。
    function isIconishControl(el) {
        if (!el || !el.tagName) return false;
        const tag = el.tagName.toLowerCase();
        if (tag === 'svg' || tag === 'img' || tag === 'i') return true;
        const text = buttonText(el);
        if (!text) return true;
        if (ICON_CHAR_RE.test(text)) return true;
        // 数值读数不算"文字标签"：音量宿主的文字就是内部滑条的 "100%"、倍速键是 "1.00X"，
        // 它们必须能通过这一层，否则位置锚定永远找不到音量键。
        if (/^\d+(\.\d+)?\s*[%xX]?$/.test(text)) return true;
        return text.length <= 2 && !/^\d/.test(text) && !/设置|标清|高清|超清|不懂|播放|暂停|下一|上一|全屏|退出/.test(text);
    }

    // 新版播放器常把图标写成 <svg><use href="#icon-volume"></use></svg>，
    // 外层 div 没有任何语义类名 —— 只能靠 href 里的关键字判断，并回到可点的宿主元素上。
    function muteHostOfSvgUse(node) {
        if (!node) return null;
        let href = '';
        try { href = String(node.getAttribute('href') || node.getAttribute('xlink:href') || ''); } catch (e) { href = ''; }
        if (!MUTE_YES_HINT_RE.test(href)) return null;
        try {
            return (node.closest && node.closest('button, a, [role="button"], span, div')) || node.parentElement || null;
        } catch (e) {
            return node.parentElement || null;
        }
    }

    // 控制条里唯一稳定的"文字锚点"：倍速（如 1.00X）
    function findRateTextEl() {
        const byClass = ['.xt_video_player_speed_show_box', '[class*="speed"]', '[class*="rate"]']
            .map((sel) => qaAny(sel).find((el) => isVisible(el) && /^\s*\d+(\.\d+)?\s*[xX]\s*$/.test(buttonText(el))))
            .find(Boolean);
        if (byClass) return byClass;
        const scope = qAny('.xt_video_player') || qAny('.xt_video_player_wrap') || document.body;
        if (!scope || !scope.querySelectorAll) return null;
        return Array.prototype.slice.call(scope.querySelectorAll('span, div, i, em, b, p'))
            .find((el) => el.children.length === 0 && isVisible(el) && /^\s*\d+(\.\d+)?\s*[xX]\s*$/.test(buttonText(el))) || null;
    }

    // 位置锚定（最后一层兜底）：控制条里音量键就在"倍速文本"右边、全屏键左边。
    // 类名每个播放器版本都可能改，但这条布局关系基本不变。
    function findMuteButtonByLayout() {
        const rateEl = findRateTextEl();
        if (!rateEl) return null;
        let node = rateEl;
        for (let depth = 0; node && depth < 5; depth++) {
            const parent = node.parentElement;
            if (!parent) break;
            const kids = Array.prototype.slice.call(parent.children).filter(isVisible);
            const idx = kids.indexOf(node);
            if (kids.length >= 3 && idx !== -1) {
                // 优先右邻居（音量键在倍速右边），再从右往左看左邻居
                const ordered = kids.slice(idx + 1).concat(kids.slice(0, idx).reverse());
                for (const cand of ordered) {
                    if (cand === node) continue;
                    const hint = elHintText(cand);
                    if (MUTE_NOT_HINT_RE.test(hint)) continue;                       // 全屏/设置/清晰度/进度条…
                    if (/不懂|问答|AI助手/.test(buttonText(cand))) continue;          // 站点的"不懂"AI 按钮
                    if (!isIconishControl(cand)) continue;                           // 文字控件跳过
                    return cand;
                }
                return null;
            }
            node = parent;
        }
        return null;
    }

    // 反向锚定：控制条最右侧是 [音量][全屏]，找不到音量键时从全屏键往左找第一个图标
    function findMuteButtonBeforeFullscreen() {
        const scope = qAny('.xt_video_player') || qAny('.xt_video_player_wrap') || null;
        const tags = 'button, a, i, span, div, svg';
        let list = [];
        try { list = Array.prototype.slice.call((scope || document).querySelectorAll(tags)); } catch (e) { list = []; }
        if (list.length === 0) list = qaAny(tags);
        const fullEl = list.find((el) => isVisible(el) && /full|fullscreen|expand|全屏/i.test(elHintText(el)) && isIconishControl(el));
        if (!fullEl || !fullEl.parentElement) return null;
        const kids = Array.prototype.slice.call(fullEl.parentElement.children).filter(isVisible);
        const idx = kids.indexOf(fullEl);
        for (let i = idx - 1; i >= 0; i--) {
            const cand = kids[i];
            const hint = elHintText(cand);
            if (MUTE_NOT_HINT_RE.test(hint)) continue;
            if (!isIconishControl(cand)) continue;
            return cand;
        }
        return null;
    }

    // 在宿主元素（含其 shadow root）里找真正可点的图标：
    // Web Component 常把 <button>/<svg> 放在自己的 shadow DOM 里，普通 querySelectorAll 看不到，
    // 而事件又不会"向下"冒泡进 shadow root，所以必须精确点到里面的那个元素。
    function findIconInside(host, depth) {
        const d = depth || 0;
        if (!host || d > 3) return null;
        const isSliderPart = (el) => /seek|handle|piped|slider|track|value|progress/i.test(typeof el.className === 'string' ? el.className : '');
        let list = [];
        try { list = Array.prototype.slice.call(host.querySelectorAll(MUTE_ICON_SEL)); } catch (e) { list = []; }
        const hit = list.find((el) => !isSliderPart(el));
        if (hit) return hit;
        // shadow root 里的按钮/图标
        let all = [];
        try { all = Array.prototype.slice.call(host.querySelectorAll('*')); } catch (e) { all = []; }
        if (host.shadowRoot) all.unshift(host);
        for (const el of all) {
            if (!el.shadowRoot) continue;
            let inner = [];
            try { inner = Array.prototype.slice.call(el.shadowRoot.querySelectorAll('button, [role="button"], ' + MUTE_ICON_SEL)); } catch (e) { inner = []; }
            const innerHit = inner.find((n) => !isSliderPart(n));
            if (innerHit) return innerHit;
            const deep = findIconInside(el.shadowRoot, d + 1);
            if (deep) return deep;
        }
        return null;
    }
    // 收集"音量键"候选（4 层策略，逐层放宽）。命中一层就返回，避免把无关控件也当候选瞎点。
    // includeHidden=true 时连"在 DOM 但暂时不可见"的控件也算候选：
    // 控制条刚淡出时控件还在文档里，点它一样能触发播放器的静音处理，比"找不到按钮"强。
    function findMuteButtons(includeHidden) {
        const roots = getPlayerRoots();
        const playerSel = '.xt_video_player, .xt_video_player_wrap, .xt_video_player_common_pc';
        const scopes = [];
        roots.forEach((r) => {
            let hit = null;
            try { hit = r.querySelector(playerSel); } catch (e) { hit = null; }
            if (hit) scopes.push(hit);
        });
        if (scopes.length === 0) scopes.push.apply(scopes, roots);
        // 播放器控件也可能在 shadow root 内部：把非顶层文档的根也加进搜索范围（Document/ShadowRoot 都支持 querySelectorAll）
        roots.forEach((r) => { if (r !== document && scopes.indexOf(r) === -1) scopes.push(r); });

        const out = [];
        // 滑条 / 数值 / 手柄这些"点了不会静音"的部件必须排除：<xt-volumeseek>、<xt-volumehandle>
        // 之类点了只会改音量，甚至把音量拖到 0 / 100。
        const isSliderPart = (cls) => /slider|seek|handle|piped|track|progress|value|tooltip|popup|panel/i.test(cls);
        const push = (el, allowInvisible) => {
            if (!el || !el.tagName || out.indexOf(el) !== -1) return;
            const tag = el.tagName.toLowerCase();
            if (tag === 'use' || tag === 'path') return;                      // 只点宿主元素，不点图标内部节点
            const cls = typeof el.className === 'string' ? el.className : '';
            if (isSliderPart(cls)) return;
            if (!includeHidden && !allowInvisible && !isVisible(el)) return;
            out.push(el);
        };
        // 命中一个"宿主容器"时，把它里面的图标元素排在前面：新版播放器的单击静音处理器挂在内层
        // <xt-icon> 上，直接点外层宿主不会触发（事件只向上冒泡）。图标即使量不出尺寸（自定义元素常是 0×0），
        // 派发的事件依然会冒泡给宿主，所以这里允许它"不可见"。
        const add = (el) => {
            if (!el || !el.tagName) return;
            const hostCls = typeof el.className === 'string' ? el.className : '';
            if (isSliderPart(hostCls)) return;
            if (!includeHidden && !isVisible(el)) return;
            const icon = findIconInside(el);
            if (icon) push(icon, true);
            push(el);
        };
        const each = (selector, fn) => {
            scopes.forEach((scope) => {
                let list = [];
                try { list = Array.prototype.slice.call(scope.querySelectorAll(selector)); } catch (e) { list = []; }
                list.forEach(fn);
            });
        };

        // 1) 类名 / title / 自定义元素标签明确命中（最快）
        MUTE_BTN_SELECTORS.concat(MUTE_BTN_TITLE_SELECTORS).forEach((sel) => each(sel, add));
        if (out.length > 0) return out;

        // 2) SVG <use href="#icon-volume"> 这类：外层无语义类名，靠 href 关键字找宿主
        each('use', (u) => add(muteHostOfSvgUse(u)));
        if (out.length > 0) return out;

        // 3) 内联 svg / img / xt-icon 的属性、类名里带 volume|mute|sound|audio 关键字
        each('svg, img, xt-icon', (s) => {
            let attr = '';
            try { attr = String(s.getAttribute('src') || s.getAttribute('viewBox') || s.getAttribute('id') || s.getAttribute('name') || ''); } catch (e) { attr = ''; }
            if (MUTE_YES_HINT_RE.test(elHintText(s) + ' ' + attr)) push(s);
            else {
                // 图标自己没线索，就看它的宿主容器有没有
                try {
                    const host = s.closest && s.closest(MUTE_HOST_SEL);
                    if (host && MUTE_YES_HINT_RE.test(elHintText(host))) push(s);
                } catch (e) { /* ignore */ }
            }
        });
        if (out.length > 0) return out;

        // 4) 位置锚定：倍速右边 / 全屏左边
        const byRate = findMuteButtonByLayout();
        if (byRate) add(byRate);
        if (out.length === 0) {
            const byFull = findMuteButtonBeforeFullscreen();
            if (byFull) add(byFull);
        }
        return out;
    }

    // 换集/切清晰度时站点会把 video.muted 回写成 false（播放器状态覆盖脚本设置），
    // 这里挂一个 volumechange 守卫：只要刷课还在跑、视频又出声了，立刻再静音，不必等下一个 3 秒巡检。
    function detachMuteGuard(state) {
        if (!state) return;
        if (state.muteGuardEl && state.muteGuardHandler) {
            try { state.muteGuardEl.removeEventListener('volumechange', state.muteGuardHandler); } catch (e) { /* ignore */ }
        }
        state.muteGuardEl = null;
        state.muteGuardHandler = null;
    }

    function attachMuteGuard(state, video) {
        if (!video || state.muteGuardEl === video) return;
        detachMuteGuard(state);
        state.muteGuardEl = video;
        state.muteGuardHandler = () => {
            if (!videoTask || videoTask !== state) return;          // 已停止刷课就不再插手
            if (video.muted) return;
            const now = Date.now();
            if (now - (state.muteGuardAt || 0) < 500) return;       // 节流：避免与站点回写互相打架形成死循环
            state.muteGuardAt = now;
            try { video.muted = true; } catch (e) { /* ignore */ }
        };
        try { video.addEventListener('volumechange', state.muteGuardHandler); } catch (e) { /* ignore */ }
    }

    // 静音策略（按可靠性从强到弱，命中即停）：
    //   ① 直接给 <video> 置 muted / volume=0 —— 不依赖任何 UI，控制条收起时也生效；
    //   ② 唤醒控制条 → 重新扫描 → 单击站点音量键（切换语义，只点一次，再点会恢复外放）；③ 都失败才提示手动点。
    // 每轮巡检都回读 video.muted：被站点回写覆盖（换集 / 切清晰度）时，下一轮会自动重新静音。
    async function ensureMuted(state) {
        const video = findVideoEl();
        if (!state.muteTriedEls) state.muteTriedEls = [];

        // 换集/换单元后 video 元素会变，之前的静音结论作废，需要重新静音
        if (video && state.muteVideoEl !== video) {
            state.muteVideoEl = video;
            state.muteTriedEls = [];
            state.muteWarned = false;
            state.muteDirectLogged = false;
            attachMuteGuard(state, video);
        }

        if (isPlayerMuted()) { state.muteWarned = false; return true; }

        // 切集 / 切清晰度后，播放器会把自己那套音量状态（如 80%）重新写回 video 元素，脚本的"直接静音"
        //   会被周期性覆盖（新视频上 muted 在 true/false 之间反复跳、volume 恒为 0.8，大部分时间实际有声）；
        //   而音量键那条路点过两次就被记进 muteTriedEls 不再重试，于是永远静不下来。
        //   这里加一层兜底：仍未静音就定期清空已试记录、重新点音量键。
        if (!state.muteRetryAt) state.muteRetryAt = 0;
        if (Date.now() - state.muteRetryAt > MUTE_RETRY_ROUND_MS) {
            state.muteRetryAt = Date.now();
            state.muteTriedEls = [];      // 允许再点一次音量键（幂等：控件是切换键，但每次点完都会回读校验）
        }

        // ---- 1) 优先"单击音量键"：这是站点的正式动线，点完站点自己的图标状态也会同步成静音 ----
        const clicked = await tryClickMuteButton(state);
        if (clicked || isPlayerMuted()) return true;

        // ---- 2) 兜底：直接把 <video> 置为静音。不依赖任何 UI，控制条收起时也能生效 ----
        // （代价是站点 UI 图标可能仍显示"有声"，但确实不出声了）
        // 同时把 volume 置 0：有些播放器只认 volume，光置 muted 会被它改回来。
        if (video && typeof video.muted === 'boolean') {
            try {
                video.muted = true;
                if (typeof video.volume === 'number' && video.volume > 0) video.volume = 0;
                video.defaultMuted = true;                 // 重新加载/换源后仍保持静音
                video.setAttribute('muted', '');
            } catch (e) { /* ignore */ }
            if (video.muted) {
                if (!state.muteDirectLogged) {
                    state.muteDirectLogged = true;
                    console.log('刷课: 音量键不可用，已直接静音 video 元素（不依赖控制条）');
                }
                state.muteWarned = false;
                return true;
            }
        }

        // ---- 3) 两条路都失败才提示 ----
        if (!state.muteWarned) {
            state.muteWarned = true;
            console.warn('[助手] 静音失败，播放器控制条诊断如下：', probeMuteControls());
            toast('静音失败（已尝试单击音量键 / 直接静音 video），请手动点一下播放器的音量键。', 'warn', 10000);
        }
        return false;
    }

    // 唤醒控制条 → 找候选音量键 → 逐个单击并用 video.muted 回读校验。
    // 生效立即收手：音量键是"切换"语义，再点一次会恢复外放。
    // 没生效说明点到的是同名容器/滑条之类，同一轮里马上换下一个候选，不用等下一轮巡检。
    async function tryClickMuteButton(state) {
        if (state.muteBusy) return false;                                        // 上一轮还没走完
        if (Date.now() - (state.muteTriedAt || 0) < CLICK_COOLDOWN_MS) return false;

        state.muteBusy = true;
        try {
            const wokeAt = Date.now();
            wakePlayerControls(state);
            await new Promise((resolve) => setTimeout(resolve, MUTE_WAKE_DELAY_MS));   // 等控制条淡入

            const unused = (el) => state.muteTriedEls.indexOf(el) === -1;
            let candidates = findMuteButtons(false).filter(unused);                    // 先找"看得见"的
            if (candidates.length === 0) candidates = findMuteButtons(true).filter(unused);   // 再放宽到隐藏残留
            candidates = candidates.slice(0, MUTE_MAX_CANDIDATES_PER_ROUND);

            for (const btn of candidates) {
                state.muteTriedEls.push(btn);
                state.muteTriedAt = Date.now();
                console.log(`刷课: 唤醒控制条(${Date.now() - wokeAt}ms)后单击音量键（切换键，同一控件只点一次）`, describeElement(btn));
                dispatchClick(btn);
                await new Promise((resolve) => setTimeout(resolve, MUTE_VERIFY_DELAY_MS));
                if (isPlayerMuted()) { state.muteWarned = false; return true; }
            }
            return false;
        } finally {
            state.muteBusy = false;
        }
    }

    // 诊断：把"播放器在哪、video 状态、控制条里有哪些控件、各层策略命中了什么"一次性打出来。
    function probeMuteControls() {
        const describe = (el) => {
            if (!el) return null;
            let cls = '';
            try { cls = (typeof el.className === 'string' ? el.className : el.getAttribute('class')) || ''; } catch (e) { cls = ''; }
            let attrs = '';
            try {
                // 把属性也打出来：Web Component 播放器的静音状态常写在属性上（如 muted / volume）
                attrs = Array.prototype.slice.call(el.attributes || [])
                    .filter((a) => !/^class$|^style$/i.test(a.name))
                    .map((a) => a.name + '=' + String(a.value).substring(0, 40))
                    .join(' ');
            } catch (e) { attrs = ''; }
            return {
                tag: el.tagName ? el.tagName.toLowerCase() : '',
                class: cls.length > 200 ? cls.substring(0, 200) + '…' : cls,
                attrs: attrs.substring(0, 200),
                text: buttonText(el).substring(0, 30),
                title: (() => { try { return (el.getAttribute('title') || el.getAttribute('aria-label')) || ''; } catch (e) { return ''; } })(),
                visible: isVisible(el),
                shadow: !!(el.shadowRoot)
            };
        };
        const video = findVideoEl();
        return {
            scriptVersion: '4.1',
            url: location.href,
            roots: getPlayerRoots(true).map((r) => (r === document ? 'document' : (r.nodeType === 9 ? 'iframe-document' : 'shadow-root'))),
            playerFound: !!qAny('.xt_video_player') || !!qAny('.xt_video_player_wrap'),
            video: video ? { muted: video.muted, volume: video.volume, paused: video.paused, src: String(video.currentSrc || video.src || '').substring(0, 120) } : null,
            // 播放器在 iframe 里？同源能进（脚本可操作），跨域进不去（脚本无解，只能手动）
            iframes: (() => {
                const list = [];
                try {
                    Array.prototype.slice.call(document.querySelectorAll('iframe')).forEach((f) => {
                        let accessible = false;
                        try { accessible = !!(f.contentDocument && f.contentDocument.querySelector); } catch (e) { accessible = false; }
                        list.push({ src: String(f.src || '').substring(0, 120), accessible: accessible });
                    });
                } catch (e) { /* ignore */ }
                return list;
            })(),
            strategies: {
                selectors: findMuteButtons(false).map(describe),
                selectorsHidden: findMuteButtons(true).map(describe),
                rateAnchor: describe(findRateTextEl()),
                byLayout: describe(findMuteButtonByLayout()),
                byFullscreen: describe(findMuteButtonBeforeFullscreen())
            },
            controlBarHtml: (() => {
                const bar = qAny('.xt_video_player_control') || qAny('.xt_video_player_common') || qAny('.xt_video_player');
                if (!bar) return null;
                try { return String(bar.outerHTML).substring(0, 4000); } catch (e) { return null; }
            })()
        };
    }

    // 视频页翻页（与答题任务解耦）：优先带「下一单元/下一节/下一章」文字的链接 → .next-btn 这类按钮
    //   → 左侧目录里"当前单元的下一项"（视频页上真正可用的向前动线）→ 兜底页脚 ">" 箭头。
    // 必须有第 3 层的原因：实测视频页上既没有「下一单元」文字链接、也没有文字是 ">" 的页脚箭头，
    //   NEXT_BTN_SELECTORS 全部落空，于是视频播完就再也不动了。
    function findNextUnitButton() {
        const xpath = "//a[contains(., '下一单元') or contains(., '下一节') or contains(., '下一章')]";
        try {
            const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (node) return node;
        } catch (e) { /* ignore */ }
        const direct = q('.next-btn a') || q('.next-btn') || q('a.next');
        if (direct) return direct;
        const sidebar = findSidebarNextUnitButton();
        if (sidebar) return sidebar;
        return findNextQuestionButton();   // 页脚/章节栏的 ">" 箭头
    }

    // 视频课时页也带 .tabbar（页脚页码条），旧判据把它当"答题页"→ 刷课在视频页直接空转。
    function isVideoLessonUrl() {
        return /\/video\//i.test(location.pathname);
    }

    function isExamPage() {
        if (isVideoLessonUrl()) return false;
        return !!(q('.answerCon') || q('.leftQuestion') || q('.tabbar'));
    }

    function parseVideoDuration() {
        // 形如 "01:23 / 10:00" 或 "视频 10:00"
        // 播放器可能在同源 iframe 里，时长文本也要从每个可搜索根里找
        let text = '';
        getPlayerRoots().forEach((r) => {
            try {
                const body = r.body || (r.nodeType === 9 ? r.body : null);
                if (body && body.innerText) text += '\n' + body.innerText;
            } catch (e) { /* ignore */ }
        });
        if (!text) text = document.body ? (document.body.innerText || '') : '';
        const match = text.match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*\/\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
        if (!match) return { parsed: false, finished: false };
        const toSec = (t) => t.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
        const cur = toSec(match[1]);
        const total = toSec(match[2]);
        if (!total) return { parsed: false, finished: false };
        return { parsed: true, finished: cur / total > 0.96 };
    }

    // ==================== 单元完成状态（左侧章节目录的绿勾）====================
    // 目录每一项的结构（现场 DOM）：<div id="unit-item-<lessonId>" class="menu-content-item [is-active]">
    //   内有 .item-type（视频/作业…）、.item-name，以及 .item-status —— 看完是 <i class="is-finish">（绿勾），
    //   未看完是 <div class="status-pie" style="--p: 25.03">（圆环百分比），没学过则留空。
    // 完成判定因此不看页面文字，而是认 .is-finish / status-pie 的 --p。
    function currentUnitItemEl() {
        // 优先 URL 里的 lessonId（最准），其次目录高亮项
        const id = currentLessonId();
        if (id) {
            const byId = q('#unit-item-' + id);
            if (byId) return byId;
        }
        const items = qa('.menu-content-item');
        return items.find((el) => /(^|\s)(is-active|active|current)(\s|$)/.test(typeof el.className === 'string' ? el.className : '')) || null;
    }

    // 指定目录项（或当前项）是否已被站点标记为"已完成"（左侧目录的绿勾）
    function isUnitItemFinished(item) {
        if (!item) return false;
        if (q('.item-status .is-finish, .item-status [class*="finish"], .item-status [class*="complete"]', item)) return true;
        const text = (item.innerText || '').trim();
        if (/已完成|已学完/.test(text)) return true;
        return false;
    }

    // 当前单元是否已被站点标记为"已完成"（左侧目录的绿勾）
    function isUnitCompleted() {
        const item = currentUnitItemEl();
        if (item) {
            if (isUnitItemFinished(item)) return true;
            const text = (item.innerText || '').trim();
            if (/未完成|未学完|未开始/.test(text)) return false;
        }
        // 兜底：页面上其它"已完成"标记（旧版页面结构仍可能用到）
        const candidates = qa('.current_unit, .chapter_item.active, .unit_active, .active_unit, li.active');
        for (const el of candidates) {
            const text = (el.innerText || '').trim();
            if (!text) continue;
            if (/未完成|未学完|未开始/.test(text)) return false;
            if (/已完成|已学完|100%/.test(text)) return true;
        }
        return false;
    }

    // 当前单元在目录里显示的观看百分比（status-pie 的 --p，或文字里的 "66.7%"）；读不到返回 null
    function currentUnitProgressPercent() {
        const item = currentUnitItemEl();
        if (!item) return null;
        const pie = q('.item-status .status-pie', item);
        if (pie) {
            const raw = (pie.getAttribute && pie.getAttribute('style')) || '';
            const m = String(raw).match(/--p\s*:\s*([\d.]+)/);
            if (m) return parseFloat(m[1]);
        }
        const m2 = (item.innerText || '').match(/([\d.]+)\s*%/);
        return m2 ? parseFloat(m2[1]) : null;
    }

    // ---------- 章节目录读取（对站点筛选友好）----------
    // 目录上有「全部 / 视频 / 图文 / 作业 / 考试」筛选：选中「视频」后站点会把非视频项从 DOM 里移除，
    //   且非当前章节是折叠的（目录项仍在 DOM 中、但高度为 0）。所以不能按 nextElementSibling 取下一项，
    //   也不能用高度判"可见" —— 统一改成按 document 顺序取全部 .menu-content-item，用下标定位下一个
    //   视频单元，点击前先展开它所在的章节。
    const UNIT_TYPE_RE = /^\s*(视频|图文|作业|考试|测验|练习|讨论|PPT|资料)/;

    function sidebarUnitItems() {
        return qa('.menu-content-item');
    }

    function unitItemType(el) {
        if (!el) return '';
        const typeEl = q('.item-type', el);
        const raw = typeEl ? (typeEl.innerText || '') : (el.innerText || '');
        const m = String(raw).match(UNIT_TYPE_RE);
        return m ? m[1] : '';
    }

    // 这个目录项是不是视频单元：类型词优先；URL 正在放视频时，lessonId 命中的项也算
    function isVideoUnitItem(el) {
        if (!el) return false;
        const type = unitItemType(el);
        if (type === '视频') return true;
        if (type) return false;
        return isVideoLessonUrl() && !!currentLessonId() && String(el.id || '').indexOf(currentLessonId()) >= 0;
    }

    // 目录筛选是不是"只看视频"（标题就写着 视频；或目录里清一色视频）
    function isVideoOnlyFilterActive() {
        const title = q('.unit-box-title');
        if (title) {
            const m = (title.innerText || '').trim().match(/^(全部|视频|图文|作业|考试)/);
            if (m && m[1] === '视频') return true;
        }
        const items = sidebarUnitItems();
        if (items.length < 2) return false;
        return items.every(isVideoUnitItem);
    }

    // 折叠章节里的目录项高度为 0，先点开它所在章节的标题（找不到标题就直接点，让站点自己处理）
    function ensureUnitItemClickable(item) {
        if (!item) return;
        try {
            const rect = item.getBoundingClientRect ? item.getBoundingClientRect() : null;
            if (rect && rect.height > 0) return;
            let node = item.parentElement;
            for (let i = 0; node && i < 6; i++) {
                const head = node.querySelector
                    ? node.querySelector('.chapter-title, .section-title, .menu-title, .unit-box-chapter-title, .chapter-item-title')
                    : null;
                if (head && head !== item) {
                    console.log('刷课: 目标单元所在章节是折叠的，先展开它。');
                    dispatchClick(head);
                    return;
                }
                node = node.parentElement;
            }
        } catch (e) { /* ignore */ }
    }

    function videoTick() {
        const state = videoTask;
        if (!state) return;

        // 检测到 SPA 路由切换后，作废上一次排队的翻页定时器，防止偷跳单元
        const currentUrl = location.href;
        if (state.url !== currentUrl) {
            state.url = currentUrl;
            state.nonVideoSince = 0;
            // 新单元需要一段"安定期"：播放器重建期间 currentTime/duration 往往是脏的，
            // 不静置就直接判"播完"，会连锁误判成"又播完了"，一跳跳过好几个单元。
            state.switchedAt = Date.now();
            state.finishHits = 0;
            state.unitDoneLogged = false;
            // 换单元后播放器会重建，静音结论作废：重置为「未点过音量键」，并摘掉旧 video 上的静音守卫
            state.muteVideoEl = null;
            state.muteTriedEls = [];
            state.muteWarned = false;
            detachMuteGuard(state);
            if (state.pendingNav) {
                clearTimeout(state.pendingNav);
                state.pendingNav = null;
                console.log('刷课: 页面已切换，取消上一次排队的翻页动作');
            }
        }

        // 注意：播放器可能被放在同源 iframe 或 Shadow DOM 里，所以用 findVideoEl() 而不是 document.querySelector
        const video = findVideoEl();
        if (!video) {
            // 非视频页：答题页绝不自动翻页
            if (isExamPage()) {
                state.nonVideoSince = 0;
                return;
            }
            if (!state.nonVideoSince) {
                state.nonVideoSince = Date.now();
                console.log('刷课: 当前单元无视频，开始计时');
                return;
            }
            if (Date.now() - state.nonVideoSince < NON_VIDEO_DWELL_MS) return;
            // 目录筛选成「视频」时，用户的意图很明确：只把视频刷完、一路往下走。
            // 这时不再要求勾选「允许自动翻页」，否则点了「自动刷课」也只会干停在这儿。
            const videoOnly = isVideoOnlyFilterActive();
            if (videoOnly && !state.videoOnlyNotice) {
                state.videoOnlyNotice = true;
                console.log('刷课: 检测到目录筛选为「视频」，按"只刷视频"模式连续刷课（不要求勾选「允许自动翻页」）。');
                toast('检测到目录筛选为「视频」：将按视频单元自动连续刷课。', 'info', 6000);
            }
            if (!getSettings().autoNext && !videoOnly) {
                if (!state.autoNextWarned) {
                    state.autoNextWarned = true;
                    toast('当前单元不是视频，已暂停自动翻页。确认完成后可勾选面板「允许自动翻页」，或把左侧目录筛选成「视频」。', 'warn', 9000);
                }
                return;
            }
            if (videoOnly) {
                // 「只刷视频」模式：停在非视频单元（图文/作业/讨论）时直接往前走；
                // 但若 URL 本身是视频课、只是播放器还没起来，就多等一会儿（VIDEO_ONLY_STALL_MS），
                // 免得把"加载慢"误当成"这个单元没视频"而跳过一整段视频。
                const stalled = Date.now() - state.nonVideoSince;
                if (isVideoLessonUrl() && stalled < VIDEO_ONLY_STALL_MS) {
                    if (!state.videoOnlyWaitWarned) {
                        state.videoOnlyWaitWarned = true;
                        console.log(`刷课: 视频单元但播放器还没就绪，等 ${Math.round(VIDEO_ONLY_STALL_MS / 1000)}s 再决定是否跳过。`);
                    }
                    return;
                }
                scheduleNextUnit(state, isUnitCompleted() ? '非视频单元已完成' : '目录筛选为视频，继续下一个视频单元');
                return;
            }
            if (isUnitCompleted()) {
                scheduleNextUnit(state, '非视频单元已完成');
            } else {
                if (!state.autoNextWarned) {
                    state.autoNextWarned = true;
                    toast('该单元尚未标记为已完成，已跳过自动翻页以免漏做任务。', 'warn', 8000);
                }
            }
            return;
        }

        state.nonVideoSince = 0;
        state.autoNextWarned = false;

        // 控制条（音量键、倍速菜单都在里面）默认收起，鼠标不动就不显示。
        // 每轮巡检先扰动一次播放器把控制条唤起来，后面的静音/倍速才点得到东西。
        wakePlayerControls(state);

        // 播放（播放按钮同样可能在 iframe/Shadow DOM 里，用 qAny）
        const playBtn = qAny('.play-btn-tip');
        if (video.paused && playBtn && (playBtn.textContent || '').trim() === '播放') {
            dispatchClick(playBtn);
        } else if (video.paused && Date.now() - (state.playTriedAt || 0) > CLICK_COOLDOWN_MS) {
            state.playTriedAt = Date.now();
            try { video.play(); } catch (e) { /* 等待用户交互 */ }
        }

        // 静音（异步：先"扰动"唤醒控制条、必要时再点音量键，所以不能阻塞本轮巡检）
        ensureMuted(state).catch((e) => console.warn('[助手] 静音流程异常', e));

        // 倍速
        const rate = Number(getSettings().playbackRate) || 1;
        const rateOk = setPlaybackRate(rate, state);
        if (!rateOk && rate !== 1) {
            if (!state.ratePendingSince) state.ratePendingSince = Date.now();
            if (Date.now() - state.ratePendingSince > RATE_RETRY_MS && !state.rateWarned) {
                state.rateWarned = true;
                toast(`倍速 ${rate}x 尚未生效，请手动确认视频播放器倍速菜单。`, 'warn', 8000);
            }
        } else if (rateOk) {
            state.ratePendingSince = 0;
        }

        // 播放完成检测：优先用 video 元素，其次用控件时长文本兜底。
        // 两道"别急着翻页"的闸门（防"一跳跳过好几个单元"）：① 刚切换单元的一小段时间内不判"播完"
        //   （新播放器的 duration/currentTime 往往是脏的，容易误判成连续翻页）；② "播完"必须连续
        //   FINISH_STABLE_HITS 轮巡检都成立（每轮 3s），单帧抖动不算。
        const sinceSwitch = Date.now() - (state.switchedAt || state.startedAt || 0);
        if (sinceSwitch < UNIT_SETTLE_MS) {
            state.finishHits = 0;
            return;
        }
        const duration = video.duration;
        let finished = false;
        if (duration && !isNaN(duration) && duration > 0) {
            finished = video.currentTime / duration > 0.96;
        } else {
            finished = parseVideoDuration().finished;
        }
        // 硬信号（可以立刻相信）：video.ended（真的播到头）｜左侧目录出现绿勾（站点已确认看完）｜
        //   目录圆环进度 ≥ 99%（站点记账口径上的"看完了"，比 video.currentTime 更可信 —— 拖进度条 / 倍速
        //   不计入时长，站点自己的百分比才是真的）。
        const unitDone = isUnitCompleted();
        const unitPercent = currentUnitProgressPercent();
        const definitelyFinished = (video.ended === true) || unitDone || (unitPercent !== null && unitPercent >= 99);
        if (definitelyFinished) {
            if (!state.unitDoneLogged) {
                state.unitDoneLogged = true;
                console.log(`刷课: ${unitDone ? '左侧目录显示该单元已完成（绿勾）' : (video.ended === true ? '视频已播放到结尾' : '目录进度已到 ' + unitPercent + '%')}，准备进入下一单元。`);
            }
            scheduleNextUnit(state, unitDone
                ? '当前单元已标记完成（绿勾）'
                : (video.ended === true ? '视频已播放到结尾' : `目录进度已到 ${unitPercent}%`));
            return;
        }
        // 软信号（进度比例）：可能被脏状态误判，要求连续 FINISH_STABLE_HITS 轮巡检都成立
        if (finished) {
            state.finishHits = (state.finishHits || 0) + 1;
            if (state.finishHits < FINISH_STABLE_HITS) {
                console.log(`刷课: 播放进度已到尾段（第 ${state.finishHits}/${FINISH_STABLE_HITS} 次确认），先不翻页。`);
                return;
            }
            scheduleNextUnit(state, '视频进度已到尾段');
        } else {
            state.finishHits = 0;
        }
    }

    // ==================== 刷课翻页（目录导航）====================
    // 视频页上常常既没有「下一单元」文字链接、也没有页脚 ">"（NEXT_BTN_SELECTORS 全部落空），
    // 真正可用的向前动线是**左侧章节目录里的下一项**；而目录项的 is-active 有时是上一次单元的陈旧状态。
    // 所以：解析 URL 里的 lessonId 定位当前单元 → 取目录顺序中的下一项 → 点击 → 轮询确认真的跳了。
    function currentLessonId() {
        const m = location.pathname.match(/\/(?:video|exercise|homework|exam|ppt|material)\/(\d+)/i);
        return m ? m[1] : null;
    }

    // 目录里"当前正在上的这一项"：优先用 URL 里的 lessonId 定位，其次用高亮项兜底。
    // 目录筛选会把非视频项从 DOM 里移除，所以当前单元有可能根本不在列表里 ——
    // 这种情况明确记日志（不再静默跳到列表第一项，那会点错单元）。
    function findCurrentUnitItem() {
        const items = sidebarUnitItems();
        if (items.length === 0) return null;
        const isActive = (el) => /(^|\s)(is-active|active|current)(\s|$)/.test(String(el.className || ''));
        const id = currentLessonId();
        if (id) {
            const byId = items.find((el) => String(el.id || '').indexOf(id) >= 0);
            if (byId) return byId;
            const active = items.find(isActive);
            if (active) {
                console.log(`[助手] 目录筛选后当前单元(${id})不在列表里，改用高亮项 ${active.id || ''}。`);
                return active;
            }
            console.warn(`[助手] 目录里找不到当前单元 ${id}（多半被目录筛选隐藏了）。`);
            return null;
        }
        return items.find(isActive) || null;
    }

    // 「下一单元」，按 document 顺序取（按 nextElementSibling 在目录筛选 / 折叠章节之后必然落空）：
    //   · 目录已筛选成「视频」→ 下一个目录项就是下一个视频；
    //   · 未筛选 → 优先紧邻的下一项（不跳过图文/作业任务），若更远处才有视频则取最近的视频单元。
    function findSidebarNextUnitButton() {
        const items = sidebarUnitItems();
        if (items.length === 0) return null;
        const current = findCurrentUnitItem();
        if (!current) return null;
        const idx = items.indexOf(current);
        if (idx < 0) return null;
        const videoOnly = isVideoOnlyFilterActive();
        for (let i = idx + 1; i < items.length; i++) {
            const item = items[i];
            if (videoOnly) return item;
            if (isVideoUnitItem(item) || i === idx + 1) return item;
        }
        return null;
    }

    // 点了"下一单元"之后到底跳没跳、跳到的是不是"我们想去的那个单元"？
    // 返回 { moved, landedOnTarget, actualId }
    //   moved          —— 页面/地址/目录高亮确实变了
    //   landedOnTarget —— 落点就是点之前算出来的那个单元（防止站点自己也在自动跳，最终跳过了单元）
    function checkUnitNavigation(beforeUrl, lessonIdBefore, targetLessonId) {
        const nowUrl = location.href;
        const nowId = currentLessonId();
        const cur = findCurrentUnitItem();
        const curId = cur ? String(cur.id || '').replace(/^unit-item-/, '') : null;
        const moved = (nowUrl !== beforeUrl) || (!!lessonIdBefore && !!nowId && nowId !== lessonIdBefore);
        const landedOnTarget = !targetLessonId
            ? true                                  // 没有目标 id 可比对时不做二次判断
            : (nowId === targetLessonId) || (curId === targetLessonId);
        return { moved: moved, landedOnTarget: landedOnTarget, actualId: nowId, actualItem: curId };
    }

    async function navigateToNextUnit(state, reason) {
        const beforeUrl = location.href;
        const lessonIdBefore = currentLessonId();
        const btn = findNextUnitButton();
        if (!btn) {
            toast('未找到「下一单元」入口（左侧章节目录里也没有下一项），请手动翻页。', 'warn', 8000);
            return false;
        }
        // 点之前先记下"我们要去的到底是哪一个单元"，跳完要核对落点，
        // 避免出现"站点自己也在跳 + 脚本又点一次 = 一次跳过好几个单元"。
        const targetLessonId = String(btn.id || '').replace(/^unit-item-/, '') || null;
        console.log(`刷课: ${reason}，点击下一单元：`,
            (btn.textContent ? String(btn.textContent).replace(/\s+/g, ' ').trim().slice(0, 30) : btn.id) +
            (targetLessonId ? `（目标 unit=${targetLessonId}）` : ''));
        // 折叠章节里的目录项高度是 0，先把它展开再点（站点对隐藏项常常收不到点击）
        ensureUnitItemClickable(btn);
        try { if (btn.scrollIntoView) btn.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
        await new Promise(resolve => setTimeout(resolve, 120));
        if (!videoTask || videoTask !== state) return false;
        dispatchClick(btn);
        // 目录项是普通 div，偶尔一次点击不被站点接住，所以给最多 3 次补点（只补点"还没跳"的情况）
        for (let i = 1; i <= 3; i++) {
            await new Promise(resolve => setTimeout(resolve, NEXT_UNIT_CONFIRM_MS));
            if (!videoTask || videoTask !== state) return false;   // 用户已停止刷课
            const nav = checkUnitNavigation(beforeUrl, lessonIdBefore, targetLessonId);
            if (nav.moved) {
                if (nav.landedOnTarget) {
                    console.log(`刷课: 已进入下一单元（第 ${i} 次确认，unit=${nav.actualId || nav.actualItem}）。`);
                    return true;
                }
                // 落点与预期不一致：多半是目录高亮陈旧或站点自己也在跳。
                // 旧版在这里直接停机（用户看到的"刷课刷着刷着不动了"），现在只警告一次就按实际落点继续刷；
                // 同时守住"本轮不再补点"，避免一次跳过好几个单元。
                if (!state.landingWarned) {
                    state.landingWarned = true;
                    console.warn(`刷课: 落点是 ${nav.actualId || nav.actualItem}，不是预期的 ${targetLessonId}（可能有其它自动跳转介入），按实际落点继续。`);
                    toast(`翻页落点与预期不一致（到了 ${nav.actualId || nav.actualItem}），已按实际落点继续刷课。`, 'warn', 9000);
                }
                return true;
            }
            const again = findNextUnitButton();
            if (again) {
                console.log(`刷课: 点击后页面未变化，第 ${i} 次补点下一单元。`);
                ensureUnitItemClickable(again);
                dispatchClick(again);
            }
        }
        toast('已点击下一单元但页面没有跳转，可能是目录项没响应；请手动确认一次。', 'warn', 8000);
        return false;
    }

    function scheduleNextUnit(state, reason) {
        if (state.pendingNav) return;
        console.log(`刷课: ${reason}，${NEXT_UNIT_DELAY_MS / 1000} 秒后进入下一单元`);
        state.pendingNav = setTimeout(() => {
            state.pendingNav = null;
            if (!videoTask || videoTask !== state) return;   // 已停止刷课则什么都不做
            navigateToNextUnit(state, reason).catch((e) => console.warn('[助手] 翻页异常', e));
        }, NEXT_UNIT_DELAY_MS);
    }

    function toggleVideoAutoplay() {
        const btn = document.getElementById('auto-video-btn');

        if (videoTask) {   // ---- 停止刷课 ----
            const state = videoTask;
            videoTask = null;
            if (state.timer) clearInterval(state.timer);
            if (state.pendingNav) {           // 一并清掉排队的翻页动作
                clearTimeout(state.pendingNav);
                state.pendingNav = null;
                console.log('刷课: 已取消排队的翻页动作');
            }
            detachMuteGuard(state);           // 摘掉静音守卫，停止刷课后不再干预播放器音量
            if (btn) { btn.innerText = '自动刷课'; btn.style.backgroundColor = '#5856D6'; }
            const video = findVideoEl();
            if (video && !video.paused) {
                const pauseBtn = qAny('.play-btn-tip');
                if (pauseBtn && (pauseBtn.textContent || '').trim() === '暂停') dispatchClick(pauseBtn);
            }
            console.log('--- 停止自动刷课 ---');
            toast('已停止自动刷课', 'info', 2500);
            syncBusyState();
            return;
        }

        if (answerTaskRunning) {
            alert('答题任务正在运行，请等它结束后再开始刷课。');
            return;
        }

        const state = {
            timer: null, pendingNav: null, url: location.href, nonVideoSince: 0,
            startedAt: Date.now(), switchedAt: Date.now(), finishHits: 0, unitDoneLogged: false,
            rateMenuOpen: false, rateOpenedAt: 0, rateWarned: false, ratePendingSince: 0,
            muteTriedAt: 0, muteWarned: false, muteVideoEl: null, muteTriedEls: [],
            muteBusy: false, muteGuardEl: null, muteGuardHandler: null, lastWakeAt: 0,
            playTriedAt: 0, autoNextWarned: false
        };
        videoTask = state;
        console.log('--- 开始自动刷课 ---');
        if (btn) { btn.innerText = '停止刷课'; btn.style.backgroundColor = '#dc3545'; }
        videoTick();
        state.timer = setInterval(videoTick, VIDEO_TICK_MS);
        syncBusyState();
    }

    // ==================== 核心功能 2: 题库管理 ====================
    function normalizeStem(text) {
        return String(text || '')
            .replace(/\s+/g, '')                       // 去掉所有空白与换行
            .replace(/[（]/g, '(').replace(/[）]/g, ')')
            .replace(/[，]/g, ',').replace(/[。]/g, '.')
            .replace(/[：]/g, ':').replace(/[；]/g, ';')
            .replace(/[？]/g, '?').replace(/[！]/g, '!')
            .replace(/[“”"]/g, '"').replace(/[‘’']/g, "'")
            .trim();
    }

    function getQuestionBank() {
        let raw;
        try { raw = GM_getValue(QUESTION_BANK_KEY, '{}'); }
        catch (e) { raw = '{}'; }
        let obj = {};
        try {
            obj = JSON.parse(raw) || {};
            if (typeof obj !== 'object' || Array.isArray(obj)) obj = {};
        } catch (e) {
            console.error('[助手] 本地题库数据损坏，已按空题库处理', e);
            toast('本地题库数据损坏，本次按空题库处理（可点「清空本地题库」后重新提取）。', 'error', 8000);
            obj = {};
        }
        return new Map(Object.entries(obj));
    }

    function findBankQuestion(bankMap, stem) {
        const key = normalizeStem(stem);
        if (!key) return null;
        if (bankMap.has(stem)) return bankMap.get(stem);
        if (bankMap.has(key)) return bankMap.get(key);
        for (const [k, v] of bankMap) {           // 兼容旧版以原始 innerText 为键的数据
            if (normalizeStem(k) === key) return v;
        }
        return null;
    }

    function updateQuestionBank(newData) {
        if (!newData || newData.length === 0) return 0;
        const bankMap = getQuestionBank();
        let addedCount = 0;
        newData.forEach(item => {
            if (!item || !item.stem) return;
            const key = normalizeStem(item.stem);
            if (!key) return;
            if (bankMap.has(key) || bankMap.has(item.stem)) return;
            bankMap.set(key, Object.assign({}, item, { stemKey: key }));
            addedCount++;
        });
        if (addedCount > 0) {
            try { GM_setValue(QUESTION_BANK_KEY, JSON.stringify(Object.fromEntries(bankMap))); }
            catch (e) { console.error('[助手] 题库写入失败', e); toast('题库写入失败：' + e.message, 'error'); return 0; }
            console.log(`题库已更新, 新增 ${addedCount} 题, 总数: ${bankMap.size}`);
        }
        return addedCount;
    }

    function clearQuestionBank() {
        const bankSize = getQuestionBank().size;
        if (bankSize === 0) { alert('本地题库已经是空的了。'); return; }
        if (confirm(`确定要清空本地存储的 ${bankSize} 道题目吗？此操作不可恢复！`)) {
            GM_setValue(QUESTION_BANK_KEY, '{}');
            alert('本地题库已清空。');
        }
    }

    // ==================== 核心功能 3: 页面交互 / 数据提取 ====================
    function parsePagePair(text) {
        const m = String(text || '').match(/(\d+)\s*\/\s*(\d+)/);
        if (!m) return null;
        const current = parseInt(m[1], 10);
        const total = parseInt(m[2], 10);
        if (!current || !total) return null;
        return { current: current, total: total };
    }

    // 页码指示器元素（形如 "7/7"）：用于在它旁边找"下一题"箭头
    function findPageIndicatorEl() {
        const inBar = qa('.tabbar .curent, .tabbar .total, .tabbar span, .tabbar div')
            .find((el) => /^\s*\d+\s*\/\s*\d+\s*$/.test(buttonText(el)));
        if (inBar) return inBar;
        // 整块文本就是 "a/b" 的元素（"已完成 6/7 题"这类含中文的进度文案不会命中）
        return qa('span, i, em, b, strong, p, div')
            .find((el) => /^\s*\d+\s*\/\s*\d+\s*$/.test(buttonText(el))) || null;
    }

    function getPageNumbers() {
        const currentEl = q('.tabbar .curent');
        const totalEl = q('.tabbar .total');
        if (currentEl && totalEl) {
            const current = parseInt((currentEl.innerText || '').trim(), 10);
            const total = parseInt((totalEl.innerText || '').replace('/', '').trim(), 10);
            if (isNaN(current) || isNaN(total)) return { current: null, total: null };
            return { current: current, total: total };
        }
        // 兜底 1：整个 .tabbar 的文本里抓 "7/7"
        const bar = q('.tabbar');
        const fromBar = bar ? parsePagePair(buttonText(bar)) : null;
        if (fromBar) return fromBar;
        // 兜底 2：页面里最小的、整块文本就是 "a/b" 的元素
        const indicator = findPageIndicatorEl();
        const fromIndicator = indicator ? parsePagePair(buttonText(indicator)) : null;
        if (fromIndicator) return fromIndicator;
        return { current: null, total: null };
    }

    async function waitForPageChange(oldPageNum, direction = 'forward') {
        const startTime = Date.now();
        const timeout = 10000;
        while (Date.now() - startTime < timeout) {
            const pageInfo = getPageNumbers();
            if (pageInfo.current) {
                if (direction === 'forward' && pageInfo.current > oldPageNum) {
                    console.log(`翻页成功: ${oldPageNum} -> ${pageInfo.current}`);
                    return true;
                }
                if (direction === 'backward' && pageInfo.current < oldPageNum) {
                    console.log(`返回成功: ${oldPageNum} -> ${pageInfo.current}`);
                    return true;
                }
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        console.warn('页面跳转检测超时。');
        return false;
    }

    // ==================== 题型识别（借鉴 PRTS：先按题型定制提示词，再按题型解析答案） ====================
    // 关键词按"越具体越靠前"排序，避免"名词解释"被误判成其它题型
    const QUESTION_TYPE_RULES = [
        ['名词解释', '名词解释'],
        ['填空', '填空题'],
        ['简答', '简答题'],
        ['论述', '论述题'],
        ['计算', '计算题'],
        ['多选', '多选题'],
        ['单选', '单选题'],
        ['判断', '判断题']
    ];
    // 没有选项、需要用文字作答的题型
    const SUBJECTIVE_TYPES = ['填空题', '简答题', '名词解释', '论述题', '计算题'];

    function isSubjectiveType(type) {
        return SUBJECTIVE_TYPES.includes(type);
    }

    function matchQuestionType(text) {
        const raw = String(text || '');
        if (!raw) return null;
        for (let i = 0; i < QUESTION_TYPE_RULES.length; i++) {
            if (raw.includes(QUESTION_TYPE_RULES[i][0])) return QUESTION_TYPE_RULES[i][1];
        }
        return null;
    }

    function detectQuestionType(questionEl) {
        const scope = (questionEl && questionEl.closest && questionEl.closest('.question')) || document;
        // 1) 题型标题里通常直接写着"【多选题】/单选题"等
        const titleText = qa('p.title, .question-title, .type-title, .title', scope)
            .map(el => el.innerText || '').join(' ');
        const fromTitle = matchQuestionType(titleText);
        if (fromTitle) return fromTitle;
        // 2) 结构兜底：判断题专用样式 / 有选项 / 只有文本框
        if (q('.panduan', scope)) return '判断题';
        if (qa('.leftQuestion .leftradio', scope).length > 0) {
            const answerScope = q('.answerCon', scope) || scope;
            return q('input[type="checkbox"]', answerScope) ? '多选题' : '单选题';
        }
        if (q('textarea, [contenteditable="true"]', q('.answerCon', scope) || scope)) return '填空题';
        // 3) 作答区是两个"对/错"按钮（✓ / ✗）=> 判断题（部分页面标题里没有"判断题"字样）
        const judgmentButtons = findJudgmentButtons();
        if (judgmentButtons.trueEl || judgmentButtons.falseEl) return '判断题';
        return '未知题型';
    }

    function scrapeCurrentPageData() {
        const questionEl = q('.leftQuestion');
        if (!questionEl) return [];

        let stemText = '';
        const stemElement = q('.fuwenben .custom_ueditor_cn_body', questionEl);
        if (stemElement) stemText = (stemElement.innerText || '').trim();
        else {
            const stemFallback = q('.fuwenben', questionEl);
            if (stemFallback) stemText = (stemFallback.innerText || '').trim();
        }
        if (!stemText) return [];

        const questionType = detectQuestionType(questionEl);
        // 判断题的作答区是两个 "✓ / ✗" 按钮，没有选项数组，但绝不是主观题（不能去填文本框）
        const isJudgment = questionType === '判断题';

        let sortKey = [999, 999];
        const match = stemText.match(/[（(]\s*(\d+)\s*[-–—]\s*(\d+)\s*[）)]/);
        if (match) sortKey = [parseInt(match[1], 10), parseInt(match[2], 10)];

        // 选项同时保留"字符串数组"（题库/导出用）和"结构化对象"（AI 解析答案用）
        const optionsList = [];
        const optionItems = [];
        qa('.leftQuestion .leftradio').forEach((optionEl, index) => {
            const letterElement = q('.radio_xtb', optionEl);
            const textElementContainer = q('.custom_ueditor_cn_body', optionEl);
            let letter = letterElement ? (letterElement.innerText || '').trim() : '';
            let text = textElementContainer ? (textElementContainer.innerText || '').trim() : '';
            if (!letter || !text) {
                const raw = (optionEl.innerText || '').trim().replace(/\s+/g, ' ');
                const labelMatch = raw.match(/^([A-Za-z])\s*[.、,，:：]?\s*/);
                if (!letter) letter = labelMatch ? labelMatch[1] : String.fromCharCode(65 + index);
                if (!text) text = labelMatch ? raw.slice(labelMatch[0].length).trim() : raw;
            }
            const letterMatch = String(letter).match(/[A-Za-z]/);
            const finalLetter = (letterMatch ? letterMatch[0] : String.fromCharCode(65 + index)).toUpperCase();
            optionItems.push({ letter: finalLetter, text: text, index: index });
            optionsList.push(`${finalLetter}. ${text}`);
        });

        const result = {
            stem: stemText,
            stemKey: normalizeStem(stemText),
            options: optionsList,
            optionItems: optionItems,
            isJudgment: isJudgment,
            isSubjective: optionItems.length === 0 && !isJudgment,
            answer: '未找到答案区域',
            sortKey: sortKey,
            type: questionType
        };
        readCorrectAnswerInto(result);
        return [result];
    }

    // 单次同步探测：当前页面是否已经渲染出"正确答案"
    function readCorrectAnswerInto(result) {
        const answerTitleElements = qa('p.myanswer');
        let container = null;
        for (const titleElement of answerTitleElements) {
            if ((titleElement.innerText || '').includes('正确答案')) {
                container = titleElement.parentElement;
                break;
            }
        }
        if (container) {
            // 判断题：正确答案区通常用 panduan + true/false 标记，或直接显示 ✓ / ✗ 字形。
            // 第 1 组按类名语义找（类名必须能通过 token 校验，所以 [class*=] 放宽也不会误判）
            const byClass = qa('[class*="panduan"], [class*="true"], [class*="false"], [class*="dui"], [class*="cuo"], [class*="check"], [class*="cross"]', container);
            for (const el of byClass) {
                const verdict = classifyJudgmentEl(el);
                if (verdict) { result.answer = verdict; return true; }
            }
            // 第 2 组只看"很短且本身就是对/错字样或字形"的元素。
            // 注意：精确词用 ^..$ 匹配；含"正确/错误"的宽松匹配必须限长度，否则"正确答案"这类整块文字会被误判。
            for (const el of qa('span, i, b, em, strong', container)) {
                const text = judgmentElementText(el, typeof el.className === 'string' ? el.className : '').replace(/[\uE000-\uF8FF]/g, '').trim();
                if (!text || text.length > 20) continue;
                if (JUDGMENT_TRUE_TEXT.test(text)) { result.answer = '正确'; return true; }
                if (JUDGMENT_FALSE_TEXT.test(text)) { result.answer = '错误'; return true; }
                if (text.length <= 3 && JUDGMENT_TRUE_GLYPH.test(text)) { result.answer = '正确'; return true; }
                if (text.length <= 3 && JUDGMENT_FALSE_GLYPH.test(text)) { result.answer = '错误'; return true; }
            }
            const parts = qa('span.radio_xtb', container).map(el => (el.innerText || '').trim()).filter(Boolean);
            if (parts.length > 0) { result.answer = parts.join(', '); return true; }
            return false;
        }
        // 兜底：从页面文本里抓 "正确答案：X"（限定在同一行且不含分隔符，避免吃到下一题）
        const pageText = document.body ? (document.body.innerText || '') : '';
        const inline = pageText.match(/正确答案\s*[:：]?\s*([A-H](?:\s*[,，、]\s*[A-H])*|正确|错误|对|错)/);
        if (inline) { result.answer = inline[1].replace(/\s+/g, ' ').trim(); return true; }
        return false;
    }

    async function waitForCorrectAnswer(result, timeoutMs = CORRECT_ANSWER_WAIT_MS) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (readCorrectAnswerInto(result)) return true;
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        return false;
    }

    // 题干指纹：翻页成功后题干必然变化，用它判断"是否真的翻过去了"（比只认页码更可靠）
    function currentStemText() {
        const el = q('.leftQuestion .fuwenben .custom_ueditor_cn_body') || q('.leftQuestion .fuwenben') || q('.leftQuestion');
        return el ? String(el.innerText || '').replace(/\s+/g, '').trim() : '';
    }

    async function waitForQuestionChange(oldStem, oldPageNum, timeoutMs = NAV_WAIT_MS) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const stem = currentStemText();
            if (stem && stem !== oldStem) { console.log('翻页成功: 题干已变化'); return true; }
            const page = getPageNumbers().current;
            if (page && oldPageNum && page > oldPageNum) {
                console.log(`翻页成功: 页码 ${oldPageNum} -> ${page}`);
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        console.warn('翻页检测超时（题干与页码都未变化）。');
        return false;
    }

    // 翻到下一题（仅"提取模式"和刷课等不提交答案的场景使用）：
    // 页内「下一题/下一页」优先，其次页脚箭头，最后兜底"文字就是 > 的元素"。
    // 答题任务不要用这个 —— 它们必须走 submitAndGotoNext()（提交 → 下一页）。
    async function navigateToNextQuestion() {
        const nextPageElement = findNextQuestionButton();
        if (!nextPageElement) return false;                 // 没有"下一题"可用 = 正常结束（末题）

        const oldStem = currentStemText();
        const oldPageNum = getPageNumbers().current;
        if (PRE_CLICK_DELAY_MS > 0) await new Promise(resolve => setTimeout(resolve, PRE_CLICK_DELAY_MS));
        dispatchClick(nextPageElement);
        return await waitForQuestionChange(oldStem, oldPageNum);
    }

    // 页脚 tabbar 的右箭头（"1 /7" 右边那个 `>`，class 是 "iconfont right"），在练习页上就是"下一题"，
    //  点一下稳定翻页（左箭头带 unselect 类，是禁用态）。它的文字是空字符串（图标用 iconfont，字形写在
    //  ::before 里），所以按文字匹配的两条路都认不出它 —— 而它是"提交按钮没有就地变成下一题"时唯一的动线。
    function findTabbarNextArrow() {
        const cands = [
            q('.tabbar i.iconfont.right'),
            q('.tabbar .right'),
            q('.tabbar i.right'),
            q('.tabbar [class*="arrow-right"]')
        ];
        for (const el of cands) {
            if (el && isVisible(el) && !isDisabledEl(el)) return el;
        }
        return null;
    }

    // 本章答完后进入下一个练习继续作答，两条入口按可用性排序：
    //   ① 页脚 ">"（能点就点）；② 左侧目录里"当前项之后的第一个 作业/考试 单元" ——
    //   本章答完后站点会给页脚 ">" 加上 `unselect`（真禁用、点了页面不动），目录才是真正可用的入口。
    // 返回 true = 已进入下一个练习（可继续循环）；false = 没有下一个了，正常收尾。
    function exerciseIdFromUrl() {
        const m = String(location.href).match(/\/exercise\/(\d+)/);
        return m ? m[1] : '';
    }

    async function waitExerciseChanged(idBefore, stemBefore, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 300));
            const idNow = exerciseIdFromUrl();
            const stemNow = (currentStemText() || '').slice(0, 30);
            if (idNow && idNow !== idBefore) return 'URL 变化';
            if (stemNow && stemBefore && stemNow !== stemBefore) return '题干变化';
        }
        return '';
    }

    async function gotoNextChapter() {
        const idBefore = exerciseIdFromUrl();
        const stemBefore = (currentStemText() || '').slice(0, 30);

        // ① 页脚 ">"（仅在未被禁用时）
        const arrow = findTabbarNextArrow();
        if (arrow) {
            console.log('[助手] 本章已答完，先试页脚 ">" 进入下一章。');
            dispatchClick(arrow);
            const why = await waitExerciseChanged(idBefore, stemBefore, 6000);
            if (why) {
                console.log('[助手] 已进入下一个练习（' + why + '）。');
                await new Promise(resolve => setTimeout(resolve, 1800));
                return true;
            }
            console.log('[助手] 页脚 ">" 点了没有反应，改从左侧目录进入下一个练习。');
        } else {
            console.log('[助手] 页脚 ">" 当前不可用（站点已将它禁用），改从左侧目录进入下一个练习。');
        }

        // ② 左侧目录：当前项之后的第一个「作业/考试」单元
        const items = sidebarUnitItems();
        if (!items.length) { console.log('[助手] 目录里没有单元项，无法继续。'); return false; }
        let idx = items.findIndex(el => /(^|\s)is-active(\s|$)/.test(String(el.className || '')));
        if (idx < 0 && idBefore) idx = items.findIndex(el => String(el.id || '').indexOf(idBefore) >= 0);
        if (idx < 0) { console.log('[助手] 没能在目录里定位当前练习，无法继续。'); return false; }

        let target = null;
        for (let i = idx + 1; i < items.length; i++) {
            const type = unitItemType(items[i]);
            if (type === '作业' || type === '考试') { target = items[i]; break; }
        }
        if (!target) { console.log('[助手] 目录里已经没有下一个练习/考试单元了，正常收尾。'); return false; }

        console.log('[助手] 点击目录里的下一个练习：' + (target.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 34));
        ensureUnitItemClickable(target);                 // 章节折叠时先展开
        await new Promise(resolve => setTimeout(resolve, 500));
        try { target.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
        dispatchClick(q('.item-name', target) || target);

        const why = await waitExerciseChanged(idBefore, stemBefore, NEXT_CHAPTER_WAIT_MS);
        if (why) {
            console.log('[助手] 已进入下一个练习（' + why + '）。');
            await new Promise(resolve => setTimeout(resolve, 1800));   // 静置，等新练习渲染完
            return true;
        }
        console.log('[助手] 点击目录项后页面没有变化，按"本章到头"处理。');
        return false;
    }

    // ==================== 答题任务的翻页动线（严格版）====================
    // 严格复刻站点动线：点「提交」→ 等同一个按钮就地变成「下一题/下一页」→ 点它 → 等题目真的换掉。
    // 必须"等"的原因：新版练习页的「下一题」是提交按钮原地变身出来的（DOM 位置不变、只换文案、去掉 disable），
    //   提交后立刻点会卡在"既不是提交、也不是下一题"的那一瞬；另有页面版本提交后按钮文案不变、
    //   站点也不自动翻页，此时唯一向前动线是 tabbar 右箭头。故动线分两级：
    //   ① 页内「下一题/下一页」→ ② tabbar 右箭头 → ③ 都没有才按末题收尾。
    // 返回值：'auto' 站点自己翻的页（脚本没点，绝不能再补点，否则连跳两题）｜'manual' 脚本点的｜
    //        'end' 本页确实没有下一页（末题，正常收尾）｜'failed' 超时或点了没反应
    async function submitAndGotoNext(oldStem, oldPageNum, timeoutMs = 12000) {
        const changed = () => {
            const page = getPageNumbers().current;
            const stem = currentStemText();
            return !!((oldPageNum && page && page !== oldPageNum) || (oldStem && stem && stem !== oldStem));
        };
        // 读不到题干也读不到页码时无法校验"是否真的翻页"，只能以"下一页点成功了"为准（和旧逻辑一致）
        const noBaseline = !oldStem && !oldPageNum;

        const pageInfo = getPageNumbers();
        const isLastPage = !!(pageInfo.current && pageInfo.total && pageInfo.current >= pageInfo.total);

        const start = Date.now();
        let clickedNext = false;
        let clickedTabbarArrow = false;
        let lastClickAt = 0;
        while (Date.now() - start < timeoutMs) {
            if (changed()) return clickedNext ? 'manual' : 'auto';

            // 页内「下一题/下一页」出现即点；点了没生效时每隔 NEXT_CTRL_RECLICK_MS 允许补点一次
            if (!clickedNext || Date.now() - lastClickAt > NEXT_CTRL_RECLICK_MS) {
                const inline = findInlineNextQuestionButton();
                if (inline) {
                    console.log(`[助手] 提交完成，点击页内「${buttonText(inline)}」进入下一题。`);
                    dispatchClick(inline);
                    clickedNext = true;
                    lastClickAt = Date.now();
                } else if (!clickedTabbarArrow && Date.now() - start > NEXT_CTRL_WAIT_MS && isLastPage) {
                    // 末题：等一小会儿页面上始终没有"下一页"控件，就正常收尾（不是失败）
                    console.log('[助手] 已到末题，页面上没有「下一题/下一页」，正常收尾。');
                    return 'end';
                } else if (!clickedTabbarArrow && Date.now() - start > NEXT_CTRL_WAIT_MS && pageInfo.current === null) {
                    // 页码读不到：无法判断是不是末页，给 tabbar 箭头一次机会，找不到就按末题收尾
                    const arrow = findTabbarNextArrow();
                    if (arrow) {
                        console.log('[助手] 页码读不到，改用页脚 tabbar 的右箭头翻页。');
                        dispatchClick(arrow);
                        clickedTabbarArrow = true;
                        clickedNext = true;
                        lastClickAt = Date.now();
                    } else {
                        console.log('[助手] 页码读不到且没有可用翻页控件，按收尾处理。');
                        return 'end';
                    }
                } else if (!clickedTabbarArrow && Date.now() - start > NEXT_CTRL_WAIT_MS) {
                    // 非末页：这一版练习页提交后按钮不会变成「下一题」，走 tabbar 右箭头（现场实测可翻页）
                    const arrow = findTabbarNextArrow();
                    if (arrow) {
                        console.log('[助手] 页内没有「下一题」，改用页脚 tabbar 的右箭头翻页（现场实测有效）。');
                        dispatchClick(arrow);
                        clickedTabbarArrow = true;
                        clickedNext = true;
                        lastClickAt = Date.now();
                    } else if (Date.now() - start > NEXT_CTRL_WAIT_MS + NEXT_CTRL_RECLICK_MS) {
                        // 既没有页内「下一题」，也没有 tabbar 右箭头：无法自行翻页，如实报失败
                        console.warn('[助手] 找不到任何可用的翻页控件（页内「下一题」与 tabbar 右箭头都没有）。');
                        return 'failed';
                    }
                }            } else if (noBaseline && Date.now() - lastClickAt > NEXT_CTRL_WAIT_MS) {
                console.warn('[助手] 页码与题干都读不到，无法校验翻页结果，按"下一页已点"继续。');
                return 'manual';
            }
            await new Promise(resolve => setTimeout(resolve, NEXT_CTRL_POLL_MS));
        }
        return 'failed';
    }

    // 提取模式（不提交答案）专用：站点不会自己翻页，只能点页内「下一题」，其次页脚 ">"。
    // 注意：答题任务不走这里 —— 那种场景必须走"提交 → 下一页"。
    async function advanceWithoutSubmit() {
        return (await navigateToNextQuestion()) ? 'manual' : 'failed';
    }

    // 点提交后若弹出"确认提交"弹窗，自动点确定（仅当弹窗文字含"提交"时才点，避免误触其它弹窗）
    async function confirmSubmitDialog(timeoutMs = 2500) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const dialog = qa('[role="dialog"], .el-dialog, .ant-modal, .modal, .xt-dialog, .confirm, .xt-modal')
                .find((el) => isVisible(el) && /提交|交卷/.test(buttonText(el)));
            if (dialog) {
                const ok = qa('button, a, [role="button"], .btn, .el-button', dialog)
                    .filter((el) => isVisible(el) && !isDisabledEl(el))
                    .find((el) => /^(确定|确认|是|提交|交卷)$/.test(buttonText(el)));
                if (ok) { console.log('[助手] 已自动确认提交弹窗'); dispatchClick(ok); return true; }
            }
            await new Promise(resolve => setTimeout(resolve, DIALOG_POLL_MS));
        }
        return false;
    }

    // ---- 提交按钮可用性：把"按钮存在"与"按钮真的可点"分开 ----
    // findSubmitButton() 本身已过滤掉禁用元素，所以它返回非空 == 站点已接住刚才的选项点击、按钮真的可点。
    const OPTION_ACTIVE_SELECTOR = [
        '.answerCon span.radio_xtb.active',
        '.answerCon span.radio_xtb.is-active',
        '.answerCon span.radio_xtb.checked',
        '.answerCon .leftradio.active .radio_xtb',
        '.answerCon .leftradio.is-active .radio_xtb'
    ].join(', ');

    // 是否已有选项处于"已选中"状态（用来判断站点是否真的接住了这次点击）
    function hasSelectedOption() {
        try {
            if (document.querySelector(OPTION_ACTIVE_SELECTOR)) return true;
            // 站点有些页面不给 .radio_xtb 挂 active，而是挂在父级 .leftradio 上、
            // 或者只在内部 input 上反映选中态；旧判据只认前一种，会误判成"没选中"而走"重选一次"的慢路径。
            return !!selectedOptionLetters();
        } catch (e) { return false; }
    }

    // 取第一枚已选中的选项，用作"重选一次激活提交按钮"的目标
    function findSelectedOptionEl() {
        try { return document.querySelector(OPTION_ACTIVE_SELECTOR); } catch (e) { return null; }
    }

    // 等"提交按钮可用"。findSubmitButton() 本身已经过滤掉 disable/aria-disabled，
    // 所以它能返回非空 == 站点已经接住刚才的选项点击、按钮真的可点。
    // 这就是替代固定 sleep(500) 的关键：把"哑等一段时间"换成"就绪即走"。
    async function waitForSubmitButton(timeoutMs = OPTION_TO_SUBMIT_TIMEOUT_MS, pollMs = OPTION_TO_SUBMIT_POLL_MS) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const btn = findSubmitButton();
            if (btn) return btn;
            if (Date.now() >= deadline) return null;
            await new Promise(resolve => setTimeout(resolve, pollMs));
        }
    }

    // 等"选项真的被站点选中"（拿到 active 类）。机器/接口慢时点一下未必立刻生效，
    // 这一步只影响"要不要重选"，不影响正常快路径。
    async function waitForOptionSelected(timeoutMs = 900, pollMs = 40) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (hasSelectedOption()) return true;
            if (Date.now() >= deadline) return false;
            await new Promise(resolve => setTimeout(resolve, pollMs));
        }
    }

    // 提交当前题：点提交 → 若弹出确认框则确认 → 回读校验是否真的交上去（没生效才重试）。
    // 关键分流（站点常见表现是"选项已选中、按钮也在，但站点还没把这次选择同步进状态，按钮仍带禁用样式 /
    //   点了不生效"，脚本却以为按钮存在就能提交 —— 旧版只在"连按钮都找不到"时才重选选项，于是"选了却不提交"）：
    //   · 已识别到选中态 → 直接点「提交(剩余N次)」；
    //   · 没识别到选中态 → 先等站点同步，仍未选中就补点一次"本次答案选过的那个选项"，再点提交；
    //   · 点了没生效 → 整体重试（正常路径总耗时 < 100ms）。
    async function submitCurrentAnswer() {
        const isSubmitGone = (btn) => !btn || !btn.isConnected;

        for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt++) {
            // 第 1 步：轮询等按钮就绪（实测站点选中选项后 0.3~0.7s 才去掉 disable 类）；
            // 重试时等更久（SUBMIT_BUTTON_SLOW_WAIT_MS）—— 站点偶发慢一拍时，多等比重点更省提交次数。
            let submitButton = await waitForSubmitButton(attempt === 1
                ? OPTION_TO_SUBMIT_TIMEOUT_MS
                : SUBMIT_BUTTON_SLOW_WAIT_MS);

            // 第 2 步：没识别到"已选中"就先等等看，仍没有则补点一次"刚才答案点过的那一个"把站点状态点活
            if (!hasSelectedOption()) {
                console.log(`[助手] 尚未识别到已选中的选项（第 ${attempt} 次提交尝试），先等待站点状态同步。`);
                await waitForOptionSelected(OPTION_SELECTED_WAIT_MS);
                if (!hasSelectedOption()) {
                    // 只补点"这一次答案真正点过的元素"：绝不退回"点第一个选项"（那会把答案改掉）
                    const selected = findSelectedOptionEl() || rememberedChoiceEl();
                    if (selected) {
                        console.log('[助手] 仍未识别到选中态，补点一次本次答案选中的选项以激活提交按钮。');
                        dispatchClick(selected);
                        await waitForOptionSelected(OPTION_SELECTED_WAIT_MS);
                    } else {
                        console.log('[助手] 识别不到选中态，也找不到本次答案点过的选项：不猜、不改答案，直接尝试点提交按钮。');
                    }
                }
                // 重选过就再给按钮一点时间变成可点
                if (!submitButton) submitButton = await waitForSubmitButton(SUBMIT_BUTTON_SLOW_WAIT_MS, OPTION_TO_SUBMIT_POLL_MS);
            }

            // 第 2.5 步：兜底 —— 有些页面版本会把 disable 类一直留在按钮上（只是样式、点得动），
            // 严格判据此时永远返回 null、导致交不上去。这里再找一次"只带 disable 类、没有 disabled 属性"
            // 的提交按钮试着点它：真点不动也没有副作用（didSubmitTakeEffect 会判定"没生效"）。
            if (isSubmitGone(submitButton)) {
                const soft = findSubmitButton({ allowSoftDisabled: true });
                if (soft) {
                    console.log('[助手] 只找到带 disable 类的提交按钮（无 disabled 属性），仍尝试点击一次。', soft.className);
                    submitButton = soft;
                }
            }

            if (isSubmitGone(submitButton)) {
                // 按钮被禁用/不存在：最后一轮才放弃，否则等站点把按钮放出来再来一次
                if (attempt < SUBMIT_MAX_ATTEMPTS) {
                    console.log('[助手] 提交按钮当前不可用，稍后重试。');
                    await new Promise(resolve => setTimeout(resolve, SUBMIT_RETRY_GAP_MS));
                    continue;
                }
                console.log('[助手] 未找到可用的提交按钮，跳过提交（可能该页无需提交或按钮仍处于禁用）。');
                return false;
            }

            console.log(`[助手] 点击提交按钮（第 ${attempt} 次尝试）：「${buttonText(submitButton)}」`);
            const timesBefore = submitTimesLeft(submitButton);
            const pageBefore = getPageNumbers().current;
            const stemBefore = currentStemText();
            dispatchClick(submitButton);

            // 点完提交后弹窗/翻页都是异步的：confirmSubmitDialog 自己带轮询，
            // 旧版在这里又固定 sleep 500ms 才去查弹窗，纯属白等，直接去掉。
            await confirmSubmitDialog();
            await new Promise(resolve => setTimeout(resolve, POST_SUBMIT_DELAY_MS));

            // 第 3 步：回读一次 —— 按钮若消失/换文案（提交成功会就地变「下一题」）、
            // 剩余次数变少、页面已经翻页，都算这次提交真的生效了。
            // 只有"按钮还在、次数没变、页面也没动"才判定没生效并重试，避免重复提交白扣次数。
            if (didSubmitTakeEffect(submitButton, timesBefore, pageBefore, stemBefore)) return true;
            if (attempt < SUBMIT_MAX_ATTEMPTS) {
                console.log('[助手] 本次点击似乎没有生效（按钮仍是「提交」且次数未变，通道回执：' + submitChannelResult() + '），再试一次。');
                await new Promise(resolve => setTimeout(resolve, SUBMIT_RETRY_GAP_MS));
            }
        }
        return false;
    }

    // AI 刷题模式的"提交到底"：第一次没生效就补救一次 ——
    //   长等一会儿（站点把 Vue 状态同步完）+ 补点"确实处于选中态"的选项激活按钮 + 再点一次提交。
    //   实测 AI 模式下最常见的失败就是"答案点上了、提交按钮那一刻还是禁用"，多花 1~2 秒远比漏交一题划算。
    async function submitWithRecovery() {
        if (await submitCurrentAnswer()) return true;
        console.log('[助手] 第一次提交没有生效，进入补救流程（等待站点同步 + 补点已选中项）。');
        await new Promise(resolve => setTimeout(resolve, 600));
        const chosen = findChosenOptionEl();
        if (chosen) {
            dispatchClick(chosen);
            await waitForOptionSelected(OPTION_SELECTED_WAIT_MS);
        }
        const ok = await submitCurrentAnswer();
        if (!ok) console.warn('[助手] 补救后仍未提交成功，本题需要手动点一次「提交」。');
        return ok;
    }

    // 读「提交(剩余N次)」里的 N；读不到返回 null
    function submitTimesLeft(btn) {
        const text = btn ? buttonText(btn) : '';
        const m = text.match(/剩余\s*(\d+)\s*次?/);
        if (m) return parseInt(m[1], 10);
        // 文案可能是「提交」+ 兄弟节点里的 "(剩余1次)"
        try {
            const host = btn && btn.parentElement ? btn.parentElement.innerText : '';
            const m2 = String(host || '').match(/剩余\s*(\d+)\s*次?/);
            if (m2) return parseInt(m2[1], 10);
        } catch (e) { /* ignore */ }
        return null;
    }

    // 提交是否真的生效（多条判据命中任意一条即算成功 —— 宁可不重试，也不要重复提交）：
    //   ① 原按钮被移除或文案不再是「提交…」（站点会把它就地变成「下一题」）；
    //   ② 「剩余N次」的 N 变小（最硬的证据：站点确实受理了这次提交）；
    //   ③ 页码 / 题干已变化（站点自己翻页了）；④ 页面上不再剩可用的「提交」按钮，或出现"已提交 / 查看解析"字样。
    function didSubmitTakeEffect(clickedButton, timesBefore, pageBefore, stemBefore) {
        try {
            if (clickedButton && clickedButton.isConnected) {
                const text = buttonText(clickedButton);
                if (!SUBMIT_EXACT_RE.test(text) && !SUBMIT_LEFT_TIMES_RE.test(text) && !/^提交/.test(text)) return true;
                const timesAfter = submitTimesLeft(clickedButton);
                if (timesBefore !== null && timesAfter !== null && timesAfter < timesBefore) return true;
            }
            if (pageBefore && getPageNumbers().current && getPageNumbers().current !== pageBefore) return true;
            if (stemBefore && currentStemText() && currentStemText() !== stemBefore) return true;
            const stillThere = findSubmitButton();
            if (!stillThere) return true;
            // 页面已明确进入"已提交/查看解析"状态
            const bodyText = document.body ? (document.body.innerText || '').slice(0, 4000) : '';
            if (/已提交|提交成功|查看答案解析|交卷成功/.test(bodyText)) return true;
        } catch (e) { /* ignore */ }
        return false;
    }

    // ==================== 核心功能 8: 选中选项 → 自动提交 ====================
    // 需求：练习/测验页里选中选项后，脚本自己点掉「提交(剩余N次)」。这是一段"旁观式"监听，
    //   复用答题任务的提交实现（submitCurrentAnswer），但与答题任务互斥 —— 任务运行时不介入
    //   （任务自己会提交，两边都点等于白扣一次提交次数）。
    // 记账模型：把"选择内容"与"用户动作"分开记（字段含义见 autoSubmitState 的注释）。
    //   换题 → 重置本题记账，并把"进场时就已存在的选中态"记为 seenSig（不提交）；
    //   同题内选择内容变了 → 记为一次用户动作；只在"这份内容是用户自己弄出来的"时才提交。
    //   旧版只用一个 armed 布尔量（要求"上一轮未选中、这一轮才选中"）是死路：已答过的题改答案
    //   永远不会再提交，且任何一次自动提交成功后 armed 复位、本题再也不碰。
    // 四条硬约束（只在该提交时提交、且只提交一次）：
    //   1) 必须真的发生过用户动作 —— 站点回显 / 上一题残留的选中态不算，免得一进页面就用掉最后一次提交机会；
    //   2) 静默期去抖 —— 多选题是"连着点好几下"，每变一次选择就重置计时，安静满 AUTO_SUBMIT_QUIET_MS（多选更长）才提交；
    //   3) 指纹去重 —— 页码 + 题干 + 已选项 组成指纹，同一指纹只自动提交一次；
    //   4) 失败不硬刚 —— 按钮没就绪 / 点了不生效都进冷却，最多 AUTO_SUBMIT_MAX_TRIES 次就收手并提示手点。
    const AUTO_SUBMIT_SCOPE_SELECTOR = '.answerCon, .leftQuestion';
    // "已选中"的类名写法：站点各版本用过 active / checked / selected / chosen / is-active
    const OPTION_CHOSEN_CLASS_RE = /(^|[\s_-])(active|checked|selected|chosen|is-active|is-checked)([\s_-]|$)/i;
    // 明确表示"没选中/被禁用"的类名，避免把 unselect / is-disabled 这类误判成选中
    const OPTION_OFF_CLASS_RE = /(^|[\s_-])(unselect|disabled?)([\s_-]|$)/i;

    const autoSubmitState = {
        lastLetters: null,  // 上一轮看到的已选字母（用于"选择变了"的判定）
        pending: null,      // { sig, timer } 静默期倒计时
        doneSig: null,      // 已经自动提交成功的指纹
        blocked: null,      // { sig, tries, until } 失败冷却
        busy: false,
        hint: null,         // 判断题没有"选中"类名，靠点击本身留个标记 { token, page, stemKey }
        // 按题记账：换了题就重新认一次基线，绝不把上一题/站点回显的选择当成本题的用户动作。
        ctxKey: null,       // 当前题的题面标识（页码 + 题干）
        lastStem: null,     // 上一轮看到的题干（用于判断"已经到下一题了"）
        seenSig: null,      // 本题"进场时就已存在、不是用户选的"那个指纹（只吞一次）
        selAt: 0,           // 当前的"选择内容"是什么时候变成现在这样的（用户每改一次就刷新）
        armedAt: 0,         // 用户最近一次"真的动手选了"的时刻
        userActed: false,   // 本题内是否捕捉到过明确的用户点击（判断题/主观题靠它）
        taskEndedAt: 0      // 答题任务结束时刻，之后一小段时间旁观逻辑不介入
    };

    function autoSubmitEnabled() {
        try { return !!getSettings().autoSubmitOnSelect; } catch (e) { return false; }
    }

    // 只在"有作答区"的答题页上工作：视频页 / 目录页什么都不做
    function isAnswerPage() {
        return !!(q('.answerCon') || q('.leftQuestion'));
    }

    // 选项元素：优先站点自己的类名，其次退到"作答区里像选项的元素"
    function optionElementsForSelection() {
        const exact = qa('.answerCon span.radio_xtb');
        if (exact.length > 0) return exact;
        return qa('.answerCon [class*="radio"], .answerCon [class*="option"], .answerCon [class*="choice"]');
    }

    // 单个元素是否"已选中"：类名 → aria → 内部 input 三层判据
    function isChosenOptionEl(el) {
        if (!el) return false;
        const cls = String(el.className || '');
        if (OPTION_CHOSEN_CLASS_RE.test(cls) && !OPTION_OFF_CLASS_RE.test(cls)) return true;
        try {
            if (el.getAttribute && (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true')) return true;
            const input = (el.tagName === 'INPUT') ? el : (el.querySelector ? el.querySelector('input') : null);
            if (input && input.checked) return true;
        } catch (e) { /* ignore */ }
        return false;
    }

    // 当前已选中的选项字母（A/B/C…），与「题库作答」用的 buildOptionIndex 同一口径：
    // 选项字母取自题目区 .leftQuestion .leftradio 的标签，按顺序对应作答区的可点元素。
    function selectedOptionLetters() {
        const spans = optionElementsForSelection();
        if (spans.length === 0) return '';
        const labels = qa('.leftQuestion .leftradio .radio_xtb').map((el) => String(el.innerText || '').trim());
        const letters = [];
        spans.forEach((span, i) => {
            const wrap = (span.closest && span.closest('.leftradio, label, li')) || null;
            if (!isChosenOptionEl(span) && !isChosenOptionEl(wrap)) return;
            const m = (labels[i] || '').match(/[A-Za-z]/);
            letters.push((m ? m[0] : String.fromCharCode(65 + i)).toUpperCase());
        });
        return Array.from(new Set(letters)).sort().join('');
    }

    // 找出"确实处于选中态"的那个可点元素 —— 只用于"补点一次激活提交按钮"。
    // 绝不回退到"点第一个选项"：那会直接把用户的答案改掉。
    function findChosenOptionEl() {
        const spans = optionElementsForSelection();
        for (let i = 0; i < spans.length; i++) {
            const span = spans[i];
            const wrap = (span.closest && span.closest('.leftradio, label, li')) || null;
            if (isChosenOptionEl(span) || isChosenOptionEl(wrap)) return span;
        }
        return null;
    }

    // 指纹：页码 + 题干 + 已选项（判断题没有选项字母，用"点过哪个 ✓/✗"补位；主观题用输入框内容）
    // 加了一层"当前题的题面标识"校验：指纹只在同一道题上有效，
    // 换题（页码/题干变了）后旧指纹一律作废 —— 避免把上一题的答案/去重记录用到这一题上。
    function autoSubmitCtxKey(page, stem) {
        return `${page === null || page === undefined ? '?' : page}#${String(stem || '').slice(0, 60)}`;
    }

    // 主观题（填空/简答）没有 A/B/C/D，选中态也不存在：改用"输入框里的内容"当选择指纹，
    // 这样"写了答案 → 自动提交"这条路也走得通（判断题走 hint，客观题走字母）。
    function subjectiveAnswerFingerprint() {
        try {
            const nodes = qa('.answerCon input, .answerCon textarea').filter((el) => {
                const type = String((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
                return type !== 'radio' && type !== 'checkbox' && type !== 'hidden';
            });
            const parts = nodes
                .map((el) => String(el.value || '').replace(/\s+/g, ' ').trim().slice(0, 40))
                .filter(Boolean);
            return parts.length > 0 ? parts.join('|') : '';
        } catch (e) { return ''; }
    }

    function selectionSignature() {
        const page = getPageNumbers().current;
        const stem = currentStemText() || '';
        const stemKey = stem.slice(0, 60);
        const letters = selectedOptionLetters();
        if (letters) return autoSubmitCtxKey(page, stem) + `#opt:${letters}`;
        const hint = autoSubmitState.hint;
        if (hint && hint.page === page && hint.stemKey === stemKey) return autoSubmitCtxKey(page, stem) + `#jd:${hint.token}`;
        const subjective = subjectiveAnswerFingerprint();
        if (subjective) return autoSubmitCtxKey(page, stem) + `#txt:${subjective}`;
        return null;
    }

    // 换了题就把"这一题"的临时状态全部清掉：重新认一次基线、重新等一次用户动作。
    // 注意不要动 blocked（失败冷却按指纹记，换题后指纹本来就变了）。
    function resetAutoSubmitForNewQuestion(ctxKey) {
        autoSubmitState.ctxKey = ctxKey;
        autoSubmitState.lastLetters = null;
        autoSubmitState.seenSig = null;
        autoSubmitState.selAt = 0;
        autoSubmitState.armedAt = 0;
        autoSubmitState.userActed = false;
        autoSubmitState.hint = null;
        resetAutoSubmitPending();
    }

    // 用户真的动手选了（点/勾/输入）→ 记一次"动作时刻"，并清掉"只吞一次"的合成基线。
    function noteUserSelectionAction() {
        autoSubmitState.armedAt = Date.now();
        autoSubmitState.userActed = true;
        autoSubmitState.seenSig = null;
    }

    // 这一轮的选择内容是不是"用户自己弄出来的"：
    //   · 内容随用户动作一起变过（selAt 晚于 armedAt）→ 是；
    //   · 或本题内捕捉到过明确的用户点击（判断题/主观题没有字母可比）→ 是。
    // 站点回显的历史选择、上一题残留的选择都不满足这两条，绝不会被自动交出去。
    function selectionIsUserMade(sig) {
        if (!sig) return false;
        if (sig === autoSubmitState.seenSig) return false;          // 本题进场时就存在的那个基线，只吞一次
        if (autoSubmitState.selAt > autoSubmitState.armedAt) return true;
        return autoSubmitState.userActed;
    }

    // 任务刚结束的一小段时间不介入（任务可能还在点"下一步"、确认弹窗可能还没落定）
    function inTaskGracePeriod() {
        return !!autoSubmitState.taskEndedAt && (Date.now() - autoSubmitState.taskEndedAt) < AUTO_SUBMIT_TASK_GRACE_MS;
    }

    function autoSubmitQuietMs() {
        try {
            const type = detectQuestionType(q('.leftQuestion'));
            if (type === '多选题' || isSubjectiveType(type)) return AUTO_SUBMIT_QUIET_MULTI_MS;
        } catch (e) { /* ignore */ }
        return AUTO_SUBMIT_QUIET_MS;
    }

    function resetAutoSubmitPending() {
        const pending = autoSubmitState.pending;
        if (pending && pending.timer) clearTimeout(pending.timer);
        autoSubmitState.pending = null;
    }

    function scheduleAutoSubmit(sig) {
        resetAutoSubmitPending();
        autoSubmitState.pending = {
            sig: sig,
            timer: setTimeout(() => {
                autoSubmitState.pending = null;
                fireAutoSubmit(sig);
            }, autoSubmitQuietMs())
        };
    }

    // 巡检：每 AUTO_SUBMIT_TICK_MS 跑一次，但在非答题页上只做一次很轻的判断就直接返回
    // 立即补一次巡检（可被连续点击合并，避免同一轮里重复排队）
    let autoSubmitKickTimer = null;
    function kickAutoSubmitTick() {
        if (autoSubmitKickTimer) return;
        autoSubmitKickTimer = setTimeout(() => {
            autoSubmitKickTimer = null;
            try { autoSubmitTick(); } catch (e) { /* ignore */ }
        }, 0);
    }

    function autoSubmitTick() {
        if (!autoSubmitEnabled()) { resetAutoSubmitPending(); return; }
        if (answerTaskRunning || videoTask) { resetAutoSubmitPending(); return; }   // 任务自己会提交
        if (inTaskGracePeriod()) { resetAutoSubmitPending(); return; }              // 任务刚结束：不介入，也**不更新记账**
        if (!isAnswerPage()) {
            resetAutoSubmitPending();
            autoSubmitState.hint = null;
            autoSubmitState.ctxKey = null;
            autoSubmitState.lastLetters = null;
            autoSubmitState.lastStem = null;
            return;
        }

        // ---- 第 0 步：先认"现在还是不是同一道题"（换题即重新记账，见 resetAutoSubmitForNewQuestion）----
        const stem = currentStemText() || '';
        const ctxKey = autoSubmitCtxKey(getPageNumbers().current, stem);
        const changedQuestion = autoSubmitState.ctxKey !== ctxKey;
        if (changedQuestion) {
            const movedOn = autoSubmitState.ctxKey !== null || (autoSubmitState.lastStem !== null && autoSubmitState.lastStem !== stem);
            resetAutoSubmitForNewQuestion(ctxKey);
            if (movedOn) console.log('[助手] 自动提交：检测到换题，已重置本题的自动提交状态（重新等一次你的选择动作）。');
        }
        autoSubmitState.lastStem = stem;

        // ---- 第 1 步：把"选择内容"和"用户动作"分开记账 ----
        const letters = selectedOptionLetters();
        const sig = selectionSignature();
        const contentChanged = autoSubmitState.lastLetters === null ? false : (letters !== autoSubmitState.lastLetters);
        if (contentChanged) autoSubmitState.selAt = Date.now();     // 选择内容刚刚变过一次
        autoSubmitState.lastLetters = letters;

        if (changedQuestion && sig) {
            // 进场时页面上"本来就带着"的选中态（站点回显 / 上一题残留 / 脚本自己点的）：
            // 记为基线且只吞一次，绝不据此提交 —— 否则等于替用户把一道没人选过的题交出去。
            // 用户之后若把选择改成这个内容（重新点选），noteUserSelectionAction 会清掉这个基线，那时才算数。
            autoSubmitState.seenSig = sig;
            autoSubmitState.selAt = 0;
            console.log('[助手] 自动提交：本题进场时已有选中态（站点回显/残留），不视为你的选择动作。');
        } else if (contentChanged && sig) {
            // 同题内选择内容变了：这一定是用户（或脚本替他点）动过手
            noteUserSelectionAction();
        }

        if (!sig) { resetAutoSubmitPending(); return; }
        if (!selectionIsUserMade(sig)) { resetAutoSubmitPending(); return; }
        if (sig === autoSubmitState.doneSig) { resetAutoSubmitPending(); return; }
        const blocked = autoSubmitState.blocked;
        if (blocked && blocked.sig === sig && (Date.now() < blocked.until || blocked.tries >= AUTO_SUBMIT_MAX_TRIES)) return;
        if (autoSubmitState.pending && autoSubmitState.pending.sig === sig) return;   // 已在静默期倒计时里
        scheduleAutoSubmit(sig);      // 选择变了 → 静默期重新计时
    }

    // 独立版"等提交按钮就绪"：只等"按了能生效"的两条硬条件 —— ① 有可点的提交按钮（findSubmitButton
    //   已排除禁用 / 不可点）；② 站点确实接住了这次选择（有选中态，或输入框里有内容）。只回 true/false，
    //   具体用哪个按钮交给后续代码再取一次（避免"找到了但不可点"被当成就绪）；不参与答题任务的阶段判断。
    async function waitUsableSubmitButton(timeoutMs, pollMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const btn = findSubmitButton() || findSubmitButton({ allowSoftDisabled: true });
            if (btn && (hasSelectedOption() || findChosenOptionEl() || subjectiveAnswerFingerprint())) return true;
            if (Date.now() >= deadline) return false;
            await new Promise(resolve => setTimeout(resolve, pollMs));
        }
    }

    async function fireAutoSubmit(sig) {
        if (!autoSubmitEnabled() || autoSubmitState.busy) return;
        if (answerTaskRunning || videoTask) return;
        if (inTaskGracePeriod()) return;
        if (sig === autoSubmitState.doneSig) return;
        const blocked = autoSubmitState.blocked;
        if (blocked && blocked.sig === sig && (Date.now() < blocked.until || blocked.tries >= AUTO_SUBMIT_MAX_TRIES)) return;
        if (selectionSignature() !== sig) return;    // 静默期里选择又变了，交给下一轮巡检
        // 临提交前再验一次"确实有东西可交"。防止时序错位：
        // 巡检记下的指纹属于上一题/已被清空的选项，等静默期一过就去点了这一题的「提交」。
        if (!hasSelectedOption() && !findChosenOptionEl() && !subjectiveAnswerFingerprint()) {
            console.log('[助手] 自动提交撤销：临提交前发现页面上没有处于选中态的选项。');
            resetAutoSubmitPending();
            return;
        }

        autoSubmitState.busy = true;
        try {
            // 独立轮询：只认"按钮可用 + 站点已接住选择"，不依赖答题任务的阶段与参数
            let ready = await waitUsableSubmitButton(AUTO_SUBMIT_ENABLE_WAIT_MS, OPTION_TO_SUBMIT_POLL_MS);
            if (!ready) {
                // 站点偶尔"看着选中了、其实没接住这次点击"（按钮仍禁用 / 选择态没同步出来）：
                // 补点一次"确实处于选中态"的那个选项激活它，再等一轮。
                const chosen = findChosenOptionEl() || rememberedChoiceEl();
                if (chosen) {
                    console.log('[助手] 提交按钮尚未就绪，补点一次已选中的选项以激活它。');
                    dispatchClick(chosen);
                    await waitForOptionSelected(OPTION_SELECTED_WAIT_MS);
                    ready = await waitUsableSubmitButton(AUTO_SUBMIT_ENABLE_WAIT2_MS, OPTION_TO_SUBMIT_POLL_MS);
                }
            }

            // 到这里还没有"可用按钮"就不硬点：没有按钮说明页面已经是别的状态（已提交/无作答区），
            // 有按钮但站点没接住选择的话，硬点也只会白扣一次提交机会。
            if (!ready) {
                const soft = findSubmitButton({ allowSoftDisabled: true });
                const graded = isQuestionAlreadySubmitted();
                if (!findChosenOptionEl() && !hasSelectedOption() && !subjectiveAnswerFingerprint()) {
                    console.log('[助手] 自动提交跳过：当前页面没有处于选中态的选项。');
                    autoSubmitState.doneSig = sig;
                    resetAutoSubmitPending();
                    return;
                }
                if (graded) {
                    console.log('[助手] 自动提交跳过：本题看起来已经提交过（页面上没有可用的「提交」按钮）。');
                    autoSubmitState.doneSig = sig;
                    return;
                }
                if (soft) console.log('[助手] 自动提交：只看到带 disable 类的提交按钮，最后再用它试一次。');
                noteAutoSubmitFailure(sig, '提交按钮没有变可用');
                return;
            }

            // 就绪后重新取一次按钮：就是"紧接着要点的那个"，判断与点击用同一个元素
            const button = findSubmitButton() || findSubmitButton({ allowSoftDisabled: true });
            if (!button) {   // 理论上不会发生（刚判定过就绪），真发生就按"没就绪"处理
                console.log('[助手] 自动提交跳过：判定就绪后按钮又消失了，等下一轮巡检。');
                return;
            }

            // 交之前最后一道闸：选择从静默期开始到现在没被人改过
            const nowSig = selectionSignature();
            if (nowSig !== sig) {
                console.log('[助手] 自动提交撤销：等待按钮就绪期间选择又变了，改为提交最新的选择。');
                scheduleAutoSubmit(nowSig);
                return;
            }

            const timesBefore = submitTimesLeft(button);
            console.log(`[助手] 检测到已选中的选项，自动点击提交：「${buttonText(button)}」`);
            const ok = await submitWithRecovery();
            if (!ok) {
                if (isQuestionAlreadySubmitted()) {   // 页面其实已经交上去了（按钮消失/出现解析）
                    console.log('[助手] 提交后页面已进入"已提交"状态，判定本次自动提交成功。');
                    autoSubmitState.doneSig = sig;
                    autoSubmitState.blocked = null;
                    return;
                }
                noteAutoSubmitFailure(sig, '点了提交但页面没有变化');
                return;
            }

            autoSubmitState.doneSig = sig;
            autoSubmitState.blocked = null;
            console.log('[助手] 自动提交成功。');
            toast(timesBefore !== null && timesBefore > 1
                ? `已自动提交本题（还剩 ${timesBefore - 1} 次提交机会）。`
                : '已自动提交本题。', 'success', 3000);
        } catch (e) {
            console.warn('[助手] 自动提交异常', e);
        } finally {
            autoSubmitState.busy = false;
        }
    }

    // 页面是否已经处于"本题已提交"的状态：没有可点的提交按钮，且出现"正确答案 / 已提交 / 查看解析"这类字样
    function isQuestionAlreadySubmitted() {
        try {
            if (findSubmitButton() || findSubmitButton({ allowSoftDisabled: true })) return false;
            const scope = q('.answerCon') || q('.leftQuestion') || document.body;
            const text = String((scope && scope.innerText) || '');
            if (/正确答案|查看解析|已提交|提交成功|重复提交|答案与解析/.test(text)) return true;
            const page = document.body ? String(document.body.innerText || '').slice(0, 4000) : '';
            return /已提交|提交成功|正确答案/.test(page);
        } catch (e) { return false; }
    }

    function noteAutoSubmitFailure(sig, reason) {
        const prev = autoSubmitState.blocked;
        const tries = (prev && prev.sig === sig ? prev.tries : 0) + 1;
        autoSubmitState.blocked = { sig: sig, tries: tries, until: Date.now() + AUTO_SUBMIT_RETRY_COOLDOWN_MS };
        if (tries >= AUTO_SUBMIT_MAX_TRIES) {
            console.warn(`[助手] 自动提交已放弃本题（${reason}），请手动点击「提交」。`);
            toast(`自动提交没有生效（${reason}），请手动点「提交」。`, 'warn', 6000);
        } else {
            console.log(`[助手] 自动提交第 ${tries} 次没成功（${reason}），稍后再试。`);
        }
    }

    // 点击/勾选监听：这是"用户真的动手了"的最权威信号，并给判断题留一个选中标记
    function onAutoSubmitPointerAction(event) {
        if (!autoSubmitEnabled()) return;
        // 答题任务运行期间由任务自己提交，旁观逻辑完全不参与：
        // 否则任务点选项会被记成"用户动作"，任务一结束就对当前题补刀（用户会看到莫名的失败提示）。
        if (answerTaskRunning || videoTask) return;
        if (inTaskGracePeriod()) return;   // 任务刚结束的静默期也不介入
        const target = event && event.target;
        if (!target || typeof target.closest !== 'function') return;

        // 手动点了「提交」也算本题已经交过，别再由脚本补一刀（剩余提交次数很宝贵）
        if (!autoSubmitState.busy) {
            try {
                const hit = target.closest('button, a, [role="button"], .btn, .el-button');
                if (hit && /提交|交卷/.test(buttonText(hit))) autoSubmitState.doneSig = selectionSignature();
            } catch (e) { /* ignore */ }
        }

        let inScope = false;
        try { inScope = !!target.closest(AUTO_SUBMIT_SCOPE_SELECTOR); } catch (e) { inScope = false; }
        if (!inScope) return;
        // 明确记一次用户动作：判断题/主观题没有选项字母可比，全靠这个信号
        noteUserSelectionAction();
        // 事件驱动再补一脚巡检：浏览器会把后台标签的 setInterval(250ms) 限流到秒级、长时间隐藏后甚至
        //   是分钟级，只靠定时器会让"点完选项就切到别的标签"迟迟等不到自动提交；用户动作才是最权威的触发点。
        kickAutoSubmitTick();

        // 判断题的 ✓/✗ 按钮点完不带任何"选中"类名，只能拿这次点击本身当判据
        let node = target;
        for (let depth = 0; node && depth < 4; depth++) {
            const kind = classifyJudgmentEl(node);
            if (kind) {
                autoSubmitState.hint = { token: kind, page: getPageNumbers().current, stemKey: (currentStemText() || '').slice(0, 60) };
                break;
            }
            node = node.parentElement;
        }
    }

    function installAutoSubmitWatcher() {
        // 幂等守卫（内部状态，不是自检接口）：重复注入/重新挂载时不要叠两套监听与定时器
        const guard = xHelperGuard();
        if (guard.autoSubmitWatcher) return;
        guard.autoSubmitWatcher = true;
        try {
            document.addEventListener('click', onAutoSubmitPointerAction, true);
            document.addEventListener('change', onAutoSubmitPointerAction, true);   // 选项是原生 input 的页面版本
        } catch (e) { /* ignore */ }
        setInterval(autoSubmitTick, AUTO_SUBMIT_TICK_MS);
        // 现场自检：把"自动提交这一套看到了什么"一次性打到控制台。
        // 测试时按 F12 执行 __xtAutoSubmitProbe()，就能看出到底是"没武装"、"按钮没点亮"还是"指纹被去重了"。
        try {
            window.__xtAutoSubmitProbe = () => {
                const page = getPageNumbers();
                const letters = selectedOptionLetters();
                const btn = findSubmitButton();
                const soft = btn || findSubmitButton({ allowSoftDisabled: true });
                const sig = selectionSignature();
                const report = {
                    url: location.href,
                    enabled: autoSubmitEnabled(),
                    taskRunning: !!answerTaskRunning,
                    videoTask: !!videoTask,
                    inTaskGrace: inTaskGracePeriod(),
                    isAnswerPage: isAnswerPage(),
                    page: page.current,
                    total: page.total,
                    stem: (currentStemText() || '').slice(0, 40),
                    ctxKey: autoSubmitState.ctxKey,
                    selectedLetters: letters,
                    chosenEl: (() => { const el = findChosenOptionEl(); return el ? { tag: el.tagName, cls: String(el.className || '').slice(0, 60) } : null; })(),
                    subjectiveText: subjectiveAnswerFingerprint().slice(0, 60),
                    isUserMade: selectionIsUserMade(sig),
                    selAt: autoSubmitState.selAt,
                    armedAt: autoSubmitState.armedAt,
                    userActed: autoSubmitState.userActed,
                    seenSig: autoSubmitState.seenSig,
                    signature: sig,
                    doneSig: autoSubmitState.doneSig,
                    deduped: !!(sig && sig === autoSubmitState.doneSig),
                    blocked: autoSubmitState.blocked,
                    pending: autoSubmitState.pending ? autoSubmitState.pending.sig : null,
                    hint: autoSubmitState.hint,
                    submitButton: soft ? { tag: soft.tagName, cls: String(soft.className || '').slice(0, 60), text: buttonText(soft), timesLeft: submitTimesLeft(soft), hardDisabled: isDisabledEl(soft) } : null,
                    alreadySubmitted: isQuestionAlreadySubmitted()
                };
                console.log('[助手] 自动提交自检：\n' + JSON.stringify(report, null, 2));
                return report;
            };
        } catch (e) { /* ignore */ }
        console.log(`[助手] 「选中选项后自动提交」已就绪（当前${autoSubmitEnabled() ? '开启' : '关闭'}，可在面板上切换；自检：__xtAutoSubmitProbe()）。`);
    }

    // 答题任务自己交过的题：把指纹写进旁观式自动提交的去重记录。否则任务点选项会把旁观逻辑"武装"起来，
    //   任务一结束（answerTaskRunning=false）它就对当前题补刀，白扣一次提交次数。
    // 参数 pinSig 是"提交之前"抓好的指纹（见 pinSubmittedSignature）：站点受理提交后会就地改按钮状态、
    //   甚至自行翻页，提交之后再算指纹可能已属于下一题，去重就会记错题。
    // 这里同时记 ctxKey，让换题判定也认它，任务翻页的瞬间不会被误当成"用户动过手"。
    function markQuestionSubmittedByTask(pinSig) {
        try {
            if (pinSig) {
                resetAutoSubmitPending();
                autoSubmitState.ctxKey = pinSig.base;
                autoSubmitState.lastLetters = null;
                autoSubmitState.hint = null;
                autoSubmitState.doneSig = pinSig.sig || pinSig.base;
                autoSubmitState.blocked = null;
                autoSubmitState.seenSig = null;
                autoSubmitState.userActed = false;
                autoSubmitState.armedAt = 0;
                autoSubmitState.selAt = 0;
                return;
            }
            resetAutoSubmitPending();
            autoSubmitState.doneSig = selectionSignature();
            autoSubmitState.blocked = null;
            autoSubmitState.hint = null;
            autoSubmitState.userActed = false;
            autoSubmitState.armedAt = 0;
            autoSubmitState.seenSig = null;
        } catch (e) { /* ignore */ }
    }

    // 点提交之前抓一次指纹：给 markQuestionSubmittedByTask 用（见上面的说明）
    function pinSubmittedSignature() {
        const page = getPageNumbers().current;
        const stem = currentStemText() || '';
        return { base: autoSubmitCtxKey(page, stem), sig: selectionSignature() };
    }

    // ==================== 判断题（作答区是两个 ✓ / ✗ 按钮） ====================
    // 判断题没有 A/B/C/D，作答区是两个"对/错"按钮（图标字形或"正确/错误"文字），既不能走
    //   clickMatchingOptions、也不能当主观题填文本框，所以单独一套：定位按钮 → 判断哪个是"正确"/"错误" → 点击。
    // 类名按空格拆成 token 逐个匹配（不能写成 (^|[-_])keyword([-_]|$)：`panduan true` 里 true 前面是空格，会漏）：
    //   true/dui/right/correct/check/tick => 正确；false/cuo/wrong/cross => 错误。
    const JUDGMENT_TRUE_CLASS = /^(.*[-_])?(true|dui|right|correct|check|tick)([-_].*)?$/i;
    const JUDGMENT_FALSE_CLASS = /^(.*[-_])?(false|cuo|wrong|cross)([-_].*)?$/i;
    // 说明：故意不把 A/B 当作判断题答案 —— 作答区只有 ✓/✗ 两个按钮，A/B 的含义不明确，猜错就是反向作答。
    const JUDGMENT_TRUE_TEXT = /^(正确|对|是|√|✓|✔|☑|T|true|1)$/i;
    const JUDGMENT_FALSE_TEXT = /^(错误|错|否|×|✗|✘|☒|╳|F|false|0)$/i;
    const JUDGMENT_TRUE_GLYPH = /[√✓✔☑]|正确|^对|^是/;
    const JUDGMENT_FALSE_GLYPH = /[×✗✘☒╳]|错误|^错|^否/;
    const ICONISH_CLASS = /icon|font|glyph|svg/i;

    function classMatches(el, re) {
        const cls = typeof el.className === 'string' ? el.className : '';
        return cls.split(/\s+/).filter(Boolean).some(token => re.test(token));
    }

    // 把各种写法的判断题答案统一成"正确" / "错误"；识别不了返回空串（宁可不作答也不反向）
    function normalizeJudgmentAnswer(answerText) {
        const text = String(answerText || '').trim();
        if (!text) return '';
        if (JUDGMENT_TRUE_TEXT.test(text)) return '正确';
        if (JUDGMENT_FALSE_TEXT.test(text)) return '错误';
        // 先剥离否定形式，避免"不正确 / 不对"被肯定词命中而反向
        const stripped = text.replace(/不正确|不对|不是|不符合/g, '');
        const isFalse = /错误|不正确|不对|不是|不符合|否|×|✗|✘|false/i.test(text);
        const isTrue = /正确|对|是|√|✓|✔|true/i.test(stripped);
        if (isFalse && !isTrue) return '错误';
        if (isTrue && !isFalse) return '正确';
        return '';
    }

    // 取元素可读的文字；图标按钮的字形常写在 ::before/::after 里（iconfont），一并读出来
    function judgmentElementText(el, cls) {
        if (!el) return '';
        let text = '';
        try { text = String(el.innerText || el.textContent || '').trim(); } catch (e) { text = ''; }
        if (text) return text;
        const iconish = el.tagName === 'I' || el.tagName === 'SVG' || ICONISH_CLASS.test(cls || '');
        if (!iconish) return '';
        try {
            ['::before', '::after'].forEach(pseudo => {
                const cs = window.getComputedStyle(el, pseudo);
                const content = cs && cs.content;
                if (content && content !== 'none' && content !== 'normal') {
                    text += ' ' + String(content).replace(/^["']|["']$/g, '');
                }
            });
        } catch (e) { /* ignore */ }
        return text.trim();
    }

    // 判断某个元素是"正确"按钮、"错误"按钮，还是与判断题无关
    function classifyJudgmentEl(el) {
        if (!el) return '';
        if (classMatches(el, JUDGMENT_TRUE_CLASS)) return '正确';
        if (classMatches(el, JUDGMENT_FALSE_CLASS)) return '错误';
        let hints = '';
        try {
            hints = String((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-value') || '')) || '');
        } catch (e) { hints = ''; }
        if (hints.trim()) {
            if (JUDGMENT_TRUE_TEXT.test(hints.trim()) || JUDGMENT_TRUE_GLYPH.test(hints)) return '正确';
            if (JUDGMENT_FALSE_TEXT.test(hints.trim()) || JUDGMENT_FALSE_GLYPH.test(hints)) return '错误';
        }
        const text = judgmentElementText(el, typeof el.className === 'string' ? el.className : '');
        if (!text) return '';
        if (JUDGMENT_TRUE_TEXT.test(text)) return '正确';
        if (JUDGMENT_FALSE_TEXT.test(text)) return '错误';
        if (JUDGMENT_TRUE_GLYPH.test(text)) return '正确';
        if (JUDGMENT_FALSE_GLYPH.test(text)) return '错误';
        return '';
    }

    // 遍历后代元素（限深限量，避免在复杂页面上变慢）
    function collectDescendants(scope, maxDepth, maxCount) {
        const out = [];
        const walk = (node, depth) => {
            if (!node || depth > maxDepth || out.length >= maxCount) return;
            const children = node.children || [];
            for (let i = 0; i < children.length; i++) {
                out.push(children[i]);
                walk(children[i], depth + 1);
            }
        };
        walk(scope, 0);
        return out;
    }

    function sharesClassToken(a, b) {
        const listA = String(typeof a.className === 'string' ? a.className : '').split(/\s+/).filter(Boolean);
        const listB = String(typeof b.className === 'string' ? b.className : '').split(/\s+/).filter(Boolean);
        return listA.some(token => listB.includes(token));
    }

    // 作答区里那种"小方块/圆点"式按钮：不套布局元素、没有文字、尺寸有限
    function isSimpleJudgmentBox(el) {
        if (!el || !el.getBoundingClientRect) return false;
        if (el.querySelector && el.querySelector('div, span, button, a, label, textarea, input, p, ul, li')) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8 || rect.width > 100 || rect.height > 100) return false;
        // 私有区字符（U+E000–U+F8FF）是 iconfont 字形，不算"有文字"
        return !String(el.innerText || '').replace(/[\uE000-\uF8FF]/g, '').trim();
    }

    // 定位作答区里的"正确 / 错误"两个按钮
    function findJudgmentButtons() {
        const scope = q('.answerCon') || q('.exam-main') || document;
        const result = { trueEl: null, falseEl: null, source: '' };
        const candidates = collectDescendants(scope, 6, 2000).filter(el => isVisible(el));

        const pick = (want) => {
            let best = null;
            let bestScore = 0;
            candidates.forEach(el => {
                const cls = typeof el.className === 'string' ? el.className : '';
                // 便宜的预过滤：明显与判断题无关的元素直接跳过，避免大量 getComputedStyle 调用
                const text = String(el.innerText || '').trim();
                if (!text && !cls && el.tagName !== 'I' && el.tagName !== 'SVG') return;
                if (classifyJudgmentEl(el) !== want) return;
                if (el.querySelector && el.querySelectorAll('*').length > 3) return;   // 跳过整块容器，只认最内层可点元素
                let score = 1;
                if (/panduan/i.test(cls)) score += 4;                                  // 学堂在线判断题专用类名
                if (classMatches(el, want === '正确' ? JUDGMENT_TRUE_CLASS : JUDGMENT_FALSE_CLASS)) score += 3;
                if (/^(span|i|button|a|svg|label|div)$/i.test(el.tagName)) score += 1;
                const rect = el.getBoundingClientRect();
                if (rect.width && rect.width <= 120 && rect.height <= 120) score += 1;
                if (score > bestScore) { bestScore = score; best = el; }
            });
            return best;
        };
        // pick() 可能选中最内层的图标元素（如 <i class="wrong">），但点击事件挂在父级 .radio_xtb.panduan 上，
        // 点图标不一定触发 Vue 的选择逻辑（结果"日志说选了、页面上却没选上"，提交按钮一直处于 disable），
        // 所以这里统一往上收敛到真正可点的容器。
        const toClickable = (el) => {
            if (!el) return el;
            let node = el;
            for (let i = 0; i < 4 && node; i++) {
                const cls = typeof node.className === 'string' ? node.className : '';
                if (/panduan|radio_xtb/i.test(cls)) return node;
                node = node.parentElement;
            }
            return el;
        };
        result.trueEl = toClickable(pick('正确'));
        result.falseEl = toClickable(pick('错误'));
        if (result.trueEl && result.falseEl) { result.source = 'class-or-text'; return result; }

        // 兜底 0（实测最可靠）：.answerCon 里第一个 .answerList 中的两个 .radio_xtb.panduan 就是 ✓ / ✗。
        // 必须排除嵌套的"正确答案"回显区（含 p.myanswer）—— 那里还挂着第 3 个 panduan，不排除会让下面的
        // marked.length === 2 兜底失效、falseEl 恒为 null，导致 AI 答"错误"时找不到按钮而跳过。
        const answerCon = q('.answerCon');
        if (answerCon) {
            // 嵌套关系是 answerList(外层) > answerList(回显区) > p.myanswer，
            // 所以不能按"该 list 内是否含 myanswer"来过滤——外层同样会命中而被误杀。
            // 要反过来做：先锁定回显区的 list，再排除落在其中的 panduan。
            const reviewLists = qa('p.myanswer', answerCon)
                .map((p) => (p.closest ? p.closest('.answerList') : null))
                .filter(Boolean);
            const pair = qa('span.radio_xtb.panduan', answerCon).filter((el) => {
                if (!isVisible(el)) return false;
                return !reviewLists.some((list) => list.contains(el));
            });
            if (pair.length >= 2) {
                if (!result.trueEl) result.trueEl = pair[0];    // 页面约定：左 ✓ 正确
                if (!result.falseEl) result.falseEl = pair[1];  // 右 ✗ 错误
                result.source = result.source || 'answerCon-panduan-pair';
                return result;
            }
        }

        if (result.trueEl || result.falseEl) { result.source = 'class-or-text'; return result; }

        // 兜底 1：作答区里用 panduan 标记的一对按钮（学堂在线判断题专用），按页面约定 左 ✓ / 右 ✗
        const marked = qa('[class*="panduan"]', scope).filter(isVisible);
        if (marked.length === 2) {
            result.trueEl = marked[0];
            result.falseEl = marked[1];
            result.source = 'panduan-order';
            return result;
        }
        // 兜底 1b：作答区只有两个 radio_xtb 且左侧一道选项行都没有 => 这两个就是 ✓ / ✗ 按钮
        const radios = qa('span.radio_xtb', scope).filter(isVisible);
        if (radios.length === 2 && qa('.leftQuestion .leftradio').length === 0) {
            result.trueEl = radios[0];
            result.falseEl = radios[1];
            result.source = 'radios-order';
            return result;
        }

        // 兜底 2：同一父节点下的一对"同标签、共享类名（如 iconfont）、无文字的小按钮" => 同样按顺序认
        const boxes = candidates.filter(isSimpleJudgmentBox).slice(0, 60);
        const groups = new Map();
        boxes.forEach(el => {
            const parent = el.parentElement;
            if (!parent) return;
            if (!groups.has(parent)) groups.set(parent, []);
            groups.get(parent).push(el);
        });
        for (const group of groups.values()) {
            if (group.length !== 2) continue;
            const a = group[0];
            const b = group[1];
            if (a.tagName !== b.tagName || !sharesClassToken(a, b)) continue;
            result.trueEl = a;      // 页面约定：左 ✓、右 ✗
            result.falseEl = b;
            result.source = 'icon-pair-order';
            return result;
        }
        return result;
    }

    function clickJudgmentAnswer(answerText) {
        const verdict = normalizeJudgmentAnswer(answerText);
        if (!verdict) {
            console.warn('[助手] 无法识别的判断题答案（不猜，避免反向作答）：', answerText);
            return false;
        }
        const buttons = findJudgmentButtons();
        const target = verdict === '正确' ? buttons.trueEl : buttons.falseEl;
        if (!target) {
            console.warn('[助手] 未找到判断题按钮', buttons);
            toast(`未找到判断题的「${verdict === '正确' ? '✓ 正确' : '✗ 错误'}」按钮，已跳过本题以免乱选。`, 'warn', 6000);
            return false;
        }
        dispatchClick(target);
        console.log(`[助手] 判断题已选择「${verdict}」（识别方式：${buttons.source}）`, target);
        return true;
    }

    // ==================== 核心功能 4: 答案点击映射 ====================
    // 用"选项字母/文本"显式匹配，不再依赖两套选择器的下标隐式对应
    function buildOptionIndex() {
        const optionDivs = qa('.leftQuestion .leftradio');
        const clickableSpans = qa('.answerCon span.radio_xtb');
        const entries = optionDivs.map((div, index) => {
            const labelEl = q('.radio_xtb', div);
            const rawLabel = labelEl ? (labelEl.innerText || '').trim() : '';
            const letterMatch = rawLabel.match(/[A-Za-z]/);
            return {
                index: index,
                letter: letterMatch ? letterMatch[0].toUpperCase() : null,
                label: rawLabel,
                span: clickableSpans[index] || null
            };
        });
        return { entries, clickableSpans };
    }

    function clickMatchingOptions(storedAnswer) {
        const { entries, clickableSpans } = buildOptionIndex();
        if (clickableSpans.length === 0) return false;

        const answerText = String(storedAnswer || '').trim();
        const isJudgment = clickableSpans[0].classList.contains('panduan') || /^(正确|错误|对|错|是|否|√|×|T|F)$/i.test(answerText);

        if (isJudgment) {
            const isTrue = /^(正确|对|是|√|T|true)$/i.test(answerText);
            const isFalse = /^(错误|错|否|×|F|false)$/i.test(answerText);
            if (isTrue) { dispatchClick(clickableSpans[0]); rememberAppliedChoice([clickableSpans[0]]); return true; }
            if (isFalse && clickableSpans[1]) { dispatchClick(clickableSpans[1]); rememberAppliedChoice([clickableSpans[1]]); return true; }
            // 无法判定的判断题：不猜，避免反向作答
            console.warn('[助手] 无法识别的判断题答案:', answerText);
            return false;
        }

        const answersToClick = answerText.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
        const wantedLetters = answersToClick.map(a => (a.match(/[A-Za-z]/) || [null])[0]).filter(Boolean).map(s => s.toUpperCase());
        let clicked = false;
        const clickedEls = [];

        entries.forEach(entry => {
            if (!entry.span) return;
            const labelText = entry.label.replace(/[.\s、]/g, '');
            const matched =
                (entry.letter && wantedLetters.includes(entry.letter)) ||
                (answersToClick.includes(entry.label)) ||
                (labelText && answersToClick.some(a => a === labelText));
            if (matched) { dispatchClick(entry.span); clicked = true; clickedEls.push(entry.span); }
        });

        if (!clicked && entries.length === clickableSpans.length) {
            // 兜底：字母表与页面标签都不匹配时按位置映射
            entries.forEach(entry => {
                if (!entry.span) return;
                const fallbackLetter = String.fromCharCode(65 + entry.index);
                if (wantedLetters.includes(fallbackLetter)) { dispatchClick(entry.span); clicked = true; clickedEls.push(entry.span); }
            });
        }
        if (clicked) rememberAppliedChoice(clickedEls);
        return clicked;
    }

    // 记住"这次答案点到了哪些元素"，用于提交失败后"补点一次激活按钮"。
    // 补点必须点回同一个选项 —— 退回"点第一个选项"等于把答案改掉再去交卷（可能把 AI 的正确答案改成 A）。
    let lastAppliedChoice = null;
    function rememberAppliedChoice(els) {
        try {
            lastAppliedChoice = {
                stemKey: (currentStemText() || '').slice(0, 60),
                els: (els || []).filter(Boolean)
            };
        } catch (e) { /* ignore */ }
    }
    function rememberedChoiceEl() {
        try {
            if (!lastAppliedChoice || lastAppliedChoice.els.length === 0) return null;
            const key = (currentStemText() || '').slice(0, 60);
            if (lastAppliedChoice.stemKey && key && lastAppliedChoice.stemKey !== key) return null;   // 已经翻页了
            return lastAppliedChoice.els.find((el) => el && el.isConnected) || null;
        } catch (e) { return null; }
    }

    // ==================== 主观题（填空/简答/名词解释/论述/计算）答案填写 ====================
    // React / Vue 受控组件必须走原生 setter 再派发 input 事件，直接改 value 不会生效
    function setNativeInputValue(el, value) {
        try {
            const proto = (el.tagName === 'TEXTAREA') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            if (descriptor && descriptor.set) descriptor.set.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        } catch (e) {
            console.warn('[助手] 写入输入框失败', e);
            return false;
        }
    }

    function escapeHtmlBasic(text) {
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function collectAnswerInputs() {
        const scope = q('.answerCon') || q('.exam-main') || document;
        let targets = qa('textarea', scope).filter(isVisible);
        if (targets.length === 0) targets = qa('textarea', scope);   // 富文本编辑器的 textarea 往往是隐藏的
        const editables = qa('[contenteditable="true"]', scope).filter(isVisible);
        return targets.concat(editables);
    }

    function fillSubjectiveAnswer(answerText) {
        const text = String(answerText || '').trim();
        if (!text) return false;
        const targets = collectAnswerInputs();
        if (targets.length === 0) return false;

        // 多个空时按 "|" 或换行拆分逐空填写；只有一个输入框则整体填入
        let parts = text.split(/\s*\|\s*/).map(s => s.trim()).filter(Boolean);
        if (parts.length <= 1) parts = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
        const useParts = targets.length > 1 && parts.length > 1;

        let filled = 0;
        targets.forEach((el, index) => {
            const value = useParts ? (parts[index] || '') : (index === 0 ? text : '');
            if (!value) return;
            if (el.isContentEditable) {
                el.focus();
                el.innerHTML = escapeHtmlBasic(value).replace(/\n/g, '<br>');
                el.dispatchEvent(new Event('input', { bubbles: true }));
                filled++;
            } else if (setNativeInputValue(el, value)) {
                filled++;
            }
        });

        if (filled > 0) console.log(`[助手] 已填写 ${filled} 个主观题输入框`);
        else toast('未找到可填写的答题输入框，请手动作答本题。', 'warn', 6000);
        return filled > 0;
    }

    // 统一入口：判断题按 ✓/✗ 作答；有可点选项就点选项；其余（主观题）写文本框
    function applyAnswerToPage(answer, questionData) {
        if (questionData && (questionData.isJudgment || questionData.type === '判断题')) return clickJudgmentAnswer(answer);
        const hasOptions = !!(questionData && (questionData.options || []).length > 0);
        if (hasOptions) return clickMatchingOptions(answer);
        // 题型没识别出来，但页面上确实有 ✓/✗ 按钮、答案本身也是对/错 => 仍按判断题作答
        if (normalizeJudgmentAnswer(answer)) {
            const buttons = findJudgmentButtons();
            if (buttons.trueEl || buttons.falseEl) return clickJudgmentAnswer(answer);
        }
        return fillSubjectiveAnswer(answer);
    }

    // ==================== 核心功能 5: 自动化流程 ====================
    function beginAnswerTask() {
        if (answerTaskRunning) { alert('已有一个答题任务在运行，请等待其结束。'); return false; }
        if (videoTask) { alert('自动刷课正在运行，请先点击「停止刷课」再执行答题任务。'); return false; }
        answerTaskRunning = true;
        // 任务期间由任务自己提交：清掉旁观式自动提交的待办并把它对本轮的记账全部作废，
        // 免得任务点击选项被记成"用户动作"，任务一结束就对当前题补刀。
        try {
            resetAutoSubmitForNewQuestion(autoSubmitState.ctxKey);
        } catch (e) { /* ignore */ }
        syncBusyState();
        return true;
    }

    function endAnswerTask() {
        answerTaskRunning = false;
        // 记下任务结束时刻：旁观式自动提交在之后的 AUTO_SUBMIT_TASK_GRACE_MS 内不介入。
        // 任务最后一步可能是"点下一页"或等确认弹窗落定，这期间刚好路过一道已选中的题时，
        // 两边都会去点「提交」—— 一次白扣提交次数。这一小段静默期专门用来避开这个重叠窗口。
        try { autoSubmitState.taskEndedAt = Date.now(); } catch (e) { /* ignore */ }
        syncBusyState();
        syncAnswerButton();
    }

    // (A) 提取 / (B) 自动答题并提取
    async function runAutomation(mode = 'extract') {
        if (!beginAnswerTask()) return;

        const triggerBtnId = mode === 'answer' ? 'auto-answer-btn' : 'auto-extract-btn';
        const triggerBtn = document.getElementById(triggerBtnId);
        const originalText = triggerBtn ? triggerBtn.innerText : '';

        try {
            let pageInfo = getPageNumbers();
            if (pageInfo.current === null) {
                // 读不到页码不再直接罢工：改用"题干是否变化"判断翻页是否成功
                console.warn('[助手] 未能读取页码信息，改用题干变化判断翻页进度。');
                toast('未读到页码，将用题干变化判断进度（页面本身仍可正常作答）。', 'warn', 6000);
            }

            if (mode === 'answer') {
                const ok = confirm(
                    '「自动答题并提取」的工作方式：\n\n' +
                    '• 每题会先随便选一个选项并【真实提交】；\n' +
                    '• 提交后从页面读取正确答案并存入题库。\n\n' +
                    '⚠️ 风险提示：\n' +
                    '1) 如果该测验计入成绩或只允许提交一次，你的答案会被提交成错误答案；\n' +
                    '2) 若课程按正确率给分，可能出现 0 分。\n\n' +
                    '如果只是想把题目存进题库，请改用「自动翻页提取」（不会提交任何答案）。\n\n' +
                    '确定继续吗？'
                );
                if (!ok) { console.log('用户取消了自动答题'); return; }
            }

            const allExtractedData = [];
            const processedStems = new Set();

            let guard = 0;
            let preSubmitStem = null;   // 提交前的题干（用于判断站点是否已自动翻页）
            let preSubmitPage = null;   // 提交前的页码
            while (true) {
                pageInfo = getPageNumbers();
                if (++guard > MAX_QUESTIONS_PER_RUN) { toast('处理题数超出上限，流程结束以防死循环。', 'error', 6000); break; }
                if (triggerBtn) triggerBtn.innerText = `${mode === 'answer' ? '答题中' : '提取中'}... ${pageInfo.current || guard}/${pageInfo.total || '?'}`;

                if (mode === 'answer') {
                    // 本模式只是"随便选一个再提交"，为的是拿到正确答案；判断题没有 A/B/C/D，改点 ✓ 按钮
                    // 注意：这里不再固定等 500ms —— submitCurrentAnswer 内部会轮询"提交按钮是否变可用"，
                    // 那个条件本身就是"站点已接住这次选项点击"，比睡固定时长更快也更准。
                    const firstOption = q('.answerCon span.radio_xtb') || findJudgmentButtons().trueEl;
                    if (firstOption) dispatchClick(firstOption);
                    // 记下提交前的题干/页码：提交后站点会自己翻页，后面不能重复翻
                    preSubmitStem = currentStemText();
                    preSubmitPage = getPageNumbers().current;
                    const preSubmitSig = pinSubmittedSignature();   // 提交前抓指纹，交给旁观逻辑去重
                    await submitWithRecovery();   // 点提交（含"提交（剩余N次）"文案）+ 自动确认弹窗
                    markQuestionSubmittedByTask(preSubmitSig);
                }

                const items = scrapeCurrentPageData();
                if (items.length > 0) {
                    const item = items[0];
                    // 提交后正确答案是异步渲染的，这里等待而不是"再盲提交一次"
                    if (mode === 'answer' && item.answer === '未找到答案区域') {
                        await waitForCorrectAnswer(item, CORRECT_ANSWER_WAIT_MS);
                    }
                    if (item.stem && !processedStems.has(item.stemKey)) {
                        processedStems.add(item.stemKey);
                        allExtractedData.push(item);
                    }
                }

                if (pageInfo.current && pageInfo.total && pageInfo.current >= pageInfo.total) { console.log('已到末页。'); break; }
                // 翻页动线按模式分流：
                //   answer（每题都提交）→ 严格"提交 → 页内下一页"（submitAndGotoNext），绝不用页脚 ">"；
                //   extract（不提交，只是抓题）→ 保持原样：页内「下一题」优先，其次页脚 ">"。
                const movedLegacy = mode === 'answer'
                    ? await submitAndGotoNext(preSubmitStem, preSubmitPage)
                    : await advanceWithoutSubmit();
                if (movedLegacy === 'failed') { toast('翻页失败或超时，流程已结束。', 'error', 6000); break; }
            }

            if (allExtractedData.length > 0) {
                const added = updateQuestionBank(allExtractedData);
                sortExtractedData(allExtractedData);
                showResultModal(allExtractedData);
                toast(`本次共提取 ${allExtractedData.length} 题，题库新增 ${added} 题。`, 'success', 6000);
            } else {
                alert('未提取到任何数据。');
            }
        } catch (e) {
            console.error('[助手] 流程异常', e);
            toast('流程异常中断：' + (e && e.message ? e.message : e), 'error', 8000);
        } finally {
            if (triggerBtn) { triggerBtn.innerText = originalText; }
            endAnswerTask();
        }
    }

    // (C) 按题库作答
    async function startAnswerFromBank() {
        if (!beginAnswerTask()) return;
        const triggerBtn = document.getElementById('answer-from-bank-btn');
        const originalText = triggerBtn ? triggerBtn.innerText : '';
        try {
            console.log('--- 任务开始: 按题库作答 ---');
            const bank = getQuestionBank();
            if (bank.size === 0) { alert('本地题库为空，无法执行此操作。请先使用「提取」或「自动答题」功能建立题库。'); return; }
            console.log(`已加载 ${bank.size} 道题目的题库。`);

            let pageInfo = getPageNumbers();
            if (pageInfo.current === null) {
                console.warn('[助手] 未能读取页码信息，改用题干变化判断翻页进度。');
                toast('未读到页码，将用题干变化判断进度（页面本身仍可正常作答）。', 'warn', 6000);
            }

            let answeredCount = 0;
            let guard = 0;
            while (true) {
                pageInfo = getPageNumbers();
                if (++guard > MAX_QUESTIONS_PER_RUN) { toast('处理题数超出上限，流程结束以防死循环。', 'error', 6000); break; }
                if (triggerBtn) triggerBtn.innerText = `智能答题... ${pageInfo.current || guard}/${pageInfo.total || '?'}`;

                const items = scrapeCurrentPageData();
                // 当前题已经交过卷（任务中途接手 / 上一次跑到本章末页留下的"查看答题卡"状态）：
                //   不重复作答（也没有「提交」按钮可点），直接往后走；已在末页就点页脚 ">" 进下一章。
                if (isQuestionAlreadySubmitted()) {
                    const pg = getPageNumbers();
                    if (pg.total && pg.current !== null && pg.current >= pg.total) {
                        if (await gotoNextChapter()) continue;
                        console.log('[助手] 当前练习已全部完成且没有下一章，正常收尾。');
                    } else {
                        console.log('[助手] 本题已提交过，跳过作答直接进入下一题。');
                        await advanceWithoutSubmit();
                        continue;
                    }
                    break;
                }
                let stopReason = '';   // 非空 = 本轮没能完成"作答 → 提交 → 下一页"，据此收尾
                if (items.length > 0 && items[0].stem) {
                    const current = items[0];
                    const stored = findBankQuestion(bank, current.stem);
                    const answer = (stored && stored.answer && stored.answer !== '未找到答案区域') ? stored.answer : '';
                    if (answer) {
                        console.log(`命中题库: "${current.stem.substring(0, 20)}..." -> ${answer}`);
                        // 有选项就点选项，没有选项（填空/简答等）就写输入框；随后自动提交
                        if (applyAnswerToPage(answer, current)) {
                            // 先记下提交前的题干/页码：用来判断"站点自己翻的页"还是"要脚本点下一页"
                            const preStem = currentStemText() || current.stem;
                            const prePage = getPageNumbers().current;
                            const preSig = pinSubmittedSignature();   // 提交前抓指纹
                            const submitted = await submitWithRecovery();
                            if (submitted || isQuestionAlreadySubmitted()) {
                                answeredCount++;
                                markQuestionSubmittedByTask(preSig);
                            } else {
                                toast('本题没能提交成功（提交按钮始终不可用）。已停在本题，请手动点一次「提交」后重新开始。', 'error', 9000);
                                break;
                            }
                            // 末题：本章答完 → 点页脚 ">" 进入下一章继续作答；没有下一章才收尾
                            if (prePage && pageInfo.total && prePage >= pageInfo.total) {
                                if (await gotoNextChapter()) continue;
                                console.log('[助手] 已到本章末页且没有下一章，正常收尾。');
                                break;
                            }
                            // 严格动线：提交 → 页内「下一题/下一页」
                            const movedBank = await submitAndGotoNext(preStem, prePage);
                            if (movedBank === 'failed') { toast('提交后未出现「下一页」或页面未变化，流程已结束。', 'error', 7000); break; }
                            continue;
                        }
                        stopReason = `第 ${guard} 题选项未能匹配（为避免乱选，本题没有提交）`;
                    } else {
                        stopReason = `第 ${guard} 题在本地题库中未命中`;
                        console.log(`题库中未找到: "${current.stem.substring(0, 20)}..."`);
                    }
                } else {
                    stopReason = '当前页面未能提取到题干';
                }

                // 没走到上面的 continue，说明本题没能完成"作答 → 提交 → 下一页"。
                // 按新规则，答题任务不再点页脚 ">" 跳过题目（那等于漏答），所以在本题停住并说明原因。
                toast(`${stopReason}，已停止流程以免用 ">" 跳过题目。补全题库后可从本题重新开始。`, 'warn', 9000);
                break;
            }
            alert(`按题库作答流程已完成，共同步提交 ${answeredCount} 题。`);
        } catch (e) {
            console.error('[助手] 答题流程异常', e);
            toast('答题流程异常中断：' + (e && e.message ? e.message : e), 'error', 8000);
        } finally {
            if (triggerBtn) triggerBtn.innerText = originalText;
            endAnswerTask();
        }
    }

    // (D) 大模型作答 —— 借鉴学习通助手PRTS：先按题型定制提示词，再按题型解析答案
    const AI_BASE_PROMPT = '你是一位专业的在线测验答题助手，具备广泛的知识面。请根据题目给出最终答案，只输出答案本身，不要输出解析、推导过程、问候语或任何多余文字。';

    // 把接口地址补全成 OpenAI 兼容的 chat/completions 地址（用户常常只填域名）
    function normalizeApiUrl(url) {
        let raw = String(url || '').trim();
        if (!raw) return '';
        if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
        raw = raw.replace(/\/+$/, '');
        if (!/\/chat\/completions$/i.test(raw)) {
            if (/\/v\d+$/i.test(raw)) raw += '/chat/completions';
            else if (!/\/v\d+\//i.test(raw)) raw += '/v1/chat/completions';
        }
        return raw;
    }

    function isReasonerModel(model) {
        return /reasoner|reasoning|o1|o3|r1/i.test(String(model || ''));
    }

    function renderOptionsForPrompt(questionData) {
        const items = questionData.optionItems || [];
        if (items.length > 0) return items.map(it => `${it.letter}. ${it.text}`).join('\n');
        return (questionData.options || []).join('\n');
    }

    function buildAIPrompt(questionData) {
        const type = questionData.type;
        const optionsText = renderOptionsForPrompt(questionData);
        const header = `题目：${questionData.stem}`;

        if (type === '判断题') {
            return `${AI_BASE_PROMPT}\n\n题型：判断题\n要求：只回复"正确"或"错误"两个字。\n\n${header}`;
        }
        if (type === '多选题') {
            return `${AI_BASE_PROMPT}\n\n题型：多选题\n要求：只回复所有正确选项的字母，按字母顺序连写（例如 AB 或 ACD），不要加标点、空格或解释。\n\n${header}\n选项：\n${optionsText}`;
        }
        if (type === '填空题') {
            return `${AI_BASE_PROMPT}\n\n题型：填空题\n要求：按顺序给出每个空的答案，多个空之间用 "|" 分隔，只输出答案内容。\n\n${header}`;
        }
        if (type === '名词解释') {
            return `${AI_BASE_PROMPT}\n\n题型：名词解释\n要求：用一段简洁准确的话解释该名词，直接输出解释内容。\n\n${header}`;
        }
        if (type === '简答题') {
            return `${AI_BASE_PROMPT}\n\n题型：简答题\n要求：分点给出简洁准确的答案，不要写成长篇论述。\n\n${header}`;
        }
        if (type === '论述题') {
            return `${AI_BASE_PROMPT}\n\n题型：论述题\n要求：给出完整、有条理的论述答案，可分点作答。\n\n${header}`;
        }
        if (type === '计算题') {
            return `${AI_BASE_PROMPT}\n\n题型：计算题\n要求：给出必要的计算步骤和最终答案。\n\n${header}`;
        }
        if (questionData.isSubjective || !optionsText) {
            return `${AI_BASE_PROMPT}\n\n要求：直接给出这道题的答案内容。\n\n${header}`;
        }
        return `${AI_BASE_PROMPT}\n\n题型：单选题\n要求：只回复一个正确选项的字母（A/B/C/D），不要加任何其他内容。\n\n${header}\n选项：\n${optionsText}`;
    }

    // 解析失败时用的"更严格"追问提示（同一道题重问一次，显著提高可用性）
    function stricterHint(questionData) {
        if (questionData.type === '判断题') return '注意：请只输出"正确"或"错误"两个字，不要输出任何解释。';
        if (questionData.type === '多选题') return '注意：请只输出正确选项的字母（例如 AB），不要输出任何文字说明。';
        if (isSubjectiveType(questionData.type) || questionData.isSubjective) return '注意：请直接输出答案内容本身，不要输出题号、解析或多余说明。';
        return '注意：请只输出一个正确选项的字母（A/B/C/D），不要输出任何解释或其他文字。';
    }

    function postJSON(url, headers, body, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: url,
                    headers: headers,
                    data: JSON.stringify(body),
                    timeout: timeoutMs || 60000,
                    onload: (res) => resolve(res),
                    onerror: () => reject(new Error('网络请求失败（请检查接口地址、网络或脚本的 @connect 权限）')),
                    ontimeout: () => reject(new Error('网络请求超时（推理模型响应较慢时可适当调大超时）'))
                });
            } else {
                fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) })
                    .then(async (res) => resolve({ status: res.status, responseText: await res.text() }))
                    .catch(reject);
            }
        });
    }

    // 从接口响应体里取正文，兼容 deepseek-reasoner 只给 reasoning_content 的情况
    function extractAIContent(responseText) {
        let data = null;
        try { data = JSON.parse(responseText); }
        catch (e) { return { ok: false, reason: '响应不是合法 JSON', raw: String(responseText || '').substring(0, 200) }; }
        if (data && data.error) {
            const msg = (data.error && (data.error.message || data.error.code)) || JSON.stringify(data.error);
            return { ok: false, reason: '接口返回错误：' + msg, raw: String(msg).substring(0, 200) };
        }
        const message = data && data.choices && data.choices[0] && data.choices[0].message;
        if (!message) return { ok: false, reason: '响应中没有 choices[0].message', raw: JSON.stringify(data).substring(0, 200) };
        const content = message.content || message.reasoning_content || '';
        if (!String(content).trim()) return { ok: false, reason: '模型返回内容为空', raw: JSON.stringify(message).substring(0, 200) };
        return { ok: true, content: String(content).trim() };
    }

    function stripAIFormatting(content) {
        let text = String(content || '').trim();
        text = text.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');   // 去掉 ``` 代码块围栏
        // 注意：这里不能预先剥离"答案/正确答案"前缀，否则"正确答案是 D"会被切碎而解析失败，
        // 交给下面的显式规则统一处理更稳妥。
        text = text.replace(/^["'“”‘’【\[\]]+|["'“”‘’【\[\]]+$/g, '');      // 去掉整体包裹的引号/书名号
        return text.trim();
    }

    // 从"已确认只含选项字母"的片段里提取字母（支持连写，如 AB / ACD）
    function lettersFromText(text, items) {
        const found = [];
        const chars = String(text || '').toUpperCase().replace(/[^A-H]/g, '');
        for (const letter of chars) {
            if (items.some(it => it.letter === letter) && !found.includes(letter)) found.push(letter);
        }
        return found.sort();
    }

    function normalizeAIAnswer(content, questionData) {
        const text = stripAIFormatting(content);
        if (!text) return '';

        if (questionData.type === '判断题') return normalizeJudgmentAnswer(text);

        // 主观题（填空/简答/名词解释/论述/计算）：原样返回文本，交给输入框填写
        if (isSubjectiveType(questionData.type) || questionData.isSubjective) return text;

        // 客观题：先建立"选项字母 -> 选项文本"索引
        const items = (questionData.optionItems && questionData.optionItems.length > 0)
            ? questionData.optionItems
            : (questionData.options || []).map((opt, index) => {
                const m = String(opt).match(/^\s*([A-Za-z])\s*[.、,，:：]?\s*(.*)$/);
                return m
                    ? { letter: m[1].toUpperCase(), text: m[2], index: index }
                    : { letter: String.fromCharCode(65 + index), text: String(opt), index: index };
            });
        if (items.length === 0) return text;

        // 1) 优先识别"答案：AB / 故选 A / 选项C"这类显式写法
        let letters = [];
        const explicit = text.match(/(?:正确答案|正确选项|答案|应选|故选|选择|选项|选)\s*(?:是|为)?\s*[:：]?\s*([A-H](?:\s*[,，、和及\/或]\s*[A-H])*)/i);
        if (explicit) letters = lettersFromText(explicit[1], items);

        // 2) 整段只由选项字母与分隔符组成（如 "AB" / "ACD" / "A、C"）=> 模型只回了字母
        if (letters.length === 0 && /^[A-Ha-h\s,，、和及\/或]{1,16}$/.test(text)) letters = lettersFromText(text, items);

        // 3) "A项正确" / "AB项" / "A、C两项均正确" 这类以字母开头的写法
        if (letters.length === 0) {
            const leading = text.match(/^\s*([A-H](?:[\s,，、和及\/或]*[A-H])*)\s*(?:[两几]?项|个|均|都|是|为|正确|错误|对|错|[.。:：]|$)/);
            if (leading) letters = lettersFromText(leading[1], items);
        }

        // 4) 仍无结果 => 模型可能直接复述了选项文本，做文本级匹配
        if (letters.length === 0) {
            const flat = normalizeStem(text);
            items.forEach(it => {
                const optText = normalizeStem(it.text);
                if (optText && optText.length >= 2 && flat.includes(optText)) letters.push(it.letter);
            });
            letters = [...new Set(letters)].sort();
        }

        return letters.join(', ');
    }

    function buildAIBody(messages) {
        const settings = getSettings();
        const model = settings.aiModel || DEFAULT_AI_MODEL;
        const body = { model: model, messages: messages, stream: false };
        // deepseek-reasoner / o1 等推理模型不支持 temperature，传了会直接 400
        if (!isReasonerModel(model)) body.temperature = 0;
        return body;
    }

    // images 可选：传入则走多模态（文字 + image_url），否则纯文字
    // 判断是否属于"值得重试"的临时故障：4xx（除 408/429）是配置/请求问题，重试没有意义
    function isTransientAIError(status) {
        if (!status) return true;                       // 网络层失败 / 超时
        if (status === 408 || status === 429) return true;
        return status >= 500;                           // 500 / 502 / 503 / 504
    }

    async function requestAIContent(questionData, extraHint, images) {
        const settings = getSettings();
        const url = normalizeApiUrl(settings.aiApiUrl);
        if (!url) return { ok: false, reason: '未配置 AI 接口地址' };
        if (!settings.aiApiKey) return { ok: false, reason: '未配置 AI 密钥' };

        // 参考资料：只把检索出来的最相关几片接在提示词后面
        const refCtx = buildReferenceContext(questionData);
        let prompt = buildAIPrompt(questionData);
        if (refCtx) prompt += '\n\n' + refCtx;
        if (extraHint) prompt += '\n\n' + extraHint;

        const useImages = Array.isArray(images) && images.length > 0;
        let content = prompt;
        if (useImages) {
            content = [{
                type: 'text',
                text: prompt + '\n\n【图片说明】题干/选项里含图片（可能是公式、符号、图表或选项配图），已随本条消息附上。'
                    + '请优先按图片内容理解题意；图片与提取到的文字冲突时，以图片为准。'
            }];
            images.forEach((im) => content.push({ type: 'image_url', image_url: { url: im.dataUrl } }));
        }

        const body = buildAIBody([{ role: 'user', content: content }]);
        const timeoutMs = useImages ? 180000 : 120000;
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + settings.aiApiKey
        };

        // 指数退避重试：503 "Service is too busy" 这类过载是临时的，等一会儿重试通常就能过
        let res = null;
        let lastErr = null;
        for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
            lastErr = null;
            try { res = await postJSON(url, headers, body, timeoutMs); }
            catch (e) { res = null; lastErr = e; }

            const status = res ? res.status : null;
            if (!isTransientAIError(status)) break;      // 不是临时故障（如 401/400）→ 重试没意义
            if (attempt === AI_MAX_RETRIES) break;
            const wait = AI_RETRY_BASE_MS * Math.pow(2, attempt);
            const why = status ? ('HTTP ' + status) : ((lastErr && lastErr.message) || '网络错误');
            console.warn(`[助手] AI 请求临时失败（${why}），${wait}ms 后重试（${attempt + 1}/${AI_MAX_RETRIES}）`);
            toast(`大模型接口暂时不可用（${why}），${Math.round(wait / 1000)}s 后自动重试…`, 'warn', wait + 800);
            await new Promise((resolve) => setTimeout(resolve, wait));
        }

        if (!res) return { ok: false, reason: (lastErr && lastErr.message) || '网络请求失败' };

        // 把 HTTP 错误显式暴露出来，不再静默失败
        if (res.status && (res.status < 200 || res.status >= 300)) {
            let detail = res.responseText || '';
            try {
                const errObj = JSON.parse(detail);
                detail = (errObj.error && (errObj.error.message || errObj.error.code)) || detail;
            } catch (e) { /* 保留原文 */ }
            const hint = res.status === 429
                ? '（触发限流：可稍后重试或放慢答题速度）'
                : (res.status >= 500 ? '（服务端过载：已自动重试仍未成功，建议过几分钟再试）' : '');
            return { ok: false, reason: `HTTP ${res.status}：${String(detail).substring(0, 160)}${hint}` };
        }
        return extractAIContent(res.responseText);
    }

    async function requestAIAnswer(questionData) {
        try {
            // 先探测题目里有没有图片：有图就走多模态让模型直接看图（题干里常是公式/符号图，纯文字提取会丢信息）
            let images = [];
            if (getSettings().visionEnabled) {
                try { images = await collectQuestionImages(); }
                catch (e) { console.warn('[助手] 视觉：取图流程异常', e); }
                if (images.length > 0) toast('检测到 ' + images.length + ' 张题目图片，已连同文字一起交给模型识别。', 'info', 4000);
            }

            let result = await requestAIContent(questionData, '', images);
            // 模型/中转不支持 image_url 时降级为纯文字，避免因为"这题有图"导致整题直接失败
            if (!result.ok && images.length > 0) {
                console.warn('[助手] 视觉请求失败，降级为纯文字重试：', result.reason);
                toast('图片识别失败，已降级为纯文字作答。', 'warn', 5000);
                images = [];
                result = await requestAIContent(questionData);
            }
            if (!result.ok) {
                console.error('[助手] 大模型请求失败', result.reason, result.raw || '');
                toast('大模型请求失败：' + result.reason, 'error', 8000);
                return '';
            }
            console.log(`[助手] 大模型原始回答 (${questionData.type})：`, result.content);
            let normalized = normalizeAIAnswer(result.content, questionData);

            if (!normalized) {
                // 解析不了就带着"更严格的格式要求"再问一次（借鉴 PRTS 的严格提示词思路）
                console.warn('[助手] 首次回答无法解析，按更严格的格式重问一次：', result.content);
                const retry = await requestAIContent(questionData, stricterHint(questionData), images);
                if (retry.ok) {
                    console.log('[助手] 重问后大模型回答：', retry.content);
                    normalized = normalizeAIAnswer(retry.content, questionData);
                    if (!normalized) result = retry;
                }
            }
            if (!normalized) toast(`大模型答案无法解析："${String(result.content || '').substring(0, 40)}"`, 'warn', 6000);
            return normalized;
        } catch (e) {
            console.error('[助手] 大模型请求异常', e);
            toast('大模型请求异常：' + (e && e.message ? e.message : e), 'error', 8000);
            return '';
        }
    }

    // 连通性自检：只发一句固定的测试话，确认地址 / 密钥 / 模型名三者都对
    async function testAIConnection(verbose) {
        const settings = getSettings();
        const url = normalizeApiUrl(settings.aiApiUrl);
        if (!settings.aiApiKey) { alert('请先填写 AI API 密钥并保存。'); return false; }
        toast(`正在测试 AI 连接：${url}（模型 ${settings.aiModel}）...`, 'info', 5000);
        try {
            const res = await postJSON(url, {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + settings.aiApiKey
            }, buildAIBody([{ role: 'user', content: '只回复"正常"两个字，不要输出其他内容。' }]), 60000);

            if (res.status && (res.status < 200 || res.status >= 300)) {
                let detail = res.responseText || '';
                try {
                    const errObj = JSON.parse(detail);
                    detail = (errObj.error && (errObj.error.message || errObj.error.code)) || detail;
                } catch (e) { /* 保留原文 */ }
                console.error('[助手] AI 连接测试失败', res.status, detail);
                toast(`AI 连接失败 (HTTP ${res.status})：${String(detail).substring(0, 140)}`, 'error', 10000);
                return false;
            }
            const parsed = extractAIContent(res.responseText);
            if (!parsed.ok) {
                console.error('[助手] AI 连接测试失败', parsed.reason, parsed.raw || '');
                toast('AI 连接失败：' + parsed.reason, 'error', 10000);
                return false;
            }
            console.log('[助手] AI 连接测试成功，模型回复：', parsed.content);
            if (verbose !== false) toast('AI 连接正常，模型回复：' + String(parsed.content).substring(0, 40), 'success', 6000);
            return true;
        } catch (e) {
            console.error('[助手] AI 连接测试异常', e);
            toast('AI 连接异常：' + (e && e.message ? e.message : e), 'error', 10000);
            return false;
        }
    }

    async function startAnswerFromAI() {
        if (!beginAnswerTask()) return;
        const triggerBtn = document.getElementById('answer-from-bank-btn');
        const originalText = triggerBtn ? triggerBtn.innerText : '';
        try {
            console.log('--- 任务开始: 大模型(AI)作答 ---');
            const settings = getSettings();
            if (!settings.aiApiKey) { alert('尚未配置大模型 API 密钥，请先在控制面板的「AI 配置」中填写并保存。'); return; }

            let pageInfo = getPageNumbers();
            if (pageInfo.current === null) {
                console.warn('[助手] 未能读取页码信息，改用题干变化判断翻页进度。');
                toast('未读到页码，将用题干变化判断进度（页面本身仍可正常作答）。', 'warn', 6000);
            }

            const collected = [];   // 需要写回本地题库的题（仅在开启「AI 答案写入题库」时使用）
            let answeredCount = 0;
            let skippedCount = 0;
            let guard = 0;
            while (true) {
                pageInfo = getPageNumbers();
                if (++guard > MAX_QUESTIONS_PER_RUN) { toast('处理题数超出上限，流程结束以防死循环。', 'error', 6000); break; }
                if (triggerBtn) triggerBtn.innerText = `AI作答... ${pageInfo.current || guard}/${pageInfo.total || '?'}`;

                const items = scrapeCurrentPageData();
                // 当前题已经交过卷（任务中途接手 / 上一次跑到本章末页留下的"查看答题卡"状态）：
                //   不重复作答（也没有「提交」按钮可点），直接往后走；已在末页就点页脚 ">" 进下一章。
                if (isQuestionAlreadySubmitted()) {
                    const pg = getPageNumbers();
                    if (pg.total && pg.current !== null && pg.current >= pg.total) {
                        if (await gotoNextChapter()) continue;
                        console.log('[助手] 当前练习已全部完成且没有下一章，正常收尾。');
                    } else {
                        console.log('[助手] 本题已提交过，跳过作答直接进入下一题。');
                        await advanceWithoutSubmit();
                        continue;
                    }
                    break;
                }
                let stopReason = '';   // 非空 = 本轮没能完成"作答 → 提交 → 下一页"，据此收尾
                if (items.length > 0 && items[0].stem) {
                    const current = items[0];
                    console.log(`[助手] 请求大模型: "${current.stem.substring(0, 20)}..." (${current.type})`);
                    const aiAnswer = await requestAIAnswer(current);
                    console.log(`[助手] 大模型最终答案: ${aiAnswer || '（空）'}`);
                    if (aiAnswer) {
                        // 有选项就点选项，没有选项（填空/简答等）就写输入框；随后自动提交并进入下一题
                        const applied = applyAnswerToPage(aiAnswer, current);
                        if (applied) {
                            if (settings.aiSaveToBank) {
                                collected.push(Object.assign({}, current, { answer: aiAnswer, source: 'ai' }));
                            }
                            // 先记下提交前的题干/页码：用来判断"站点自己翻的页"还是"要脚本点下一页"
                            const preStem = currentStemText() || current.stem;
                            const prePage = getPageNumbers().current;
                            const preSig = pinSubmittedSignature();   // 提交前抓指纹
                            const submitted = await submitWithRecovery();   // 点提交 + 自动确认弹窗（失败会补一次）
                            if (submitted || isQuestionAlreadySubmitted()) {
                                answeredCount++;
                                markQuestionSubmittedByTask(preSig);
                            } else {
                                // 交不上去就别往后跳了：停在本题，避免留下一串"选了但没交"的题
                                toast('本题没能提交成功（提交按钮始终不可用）。已停在本题，请手动点一次「提交」后重新开始。', 'error', 9000);
                                break;
                            }
                            // 末题：本章答完 → 点页脚 ">" 进入下一章继续作答；没有下一章才收尾
                            if (prePage && pageInfo.total && prePage >= pageInfo.total) {
                                if (await gotoNextChapter()) continue;
                                console.log('[助手] 已到本章末页且没有下一章，正常收尾。');
                                break;
                            }
                            // 严格动线：提交 → 页内「下一题/下一页」
                            const moved = await submitAndGotoNext(preStem, prePage);
                            if (moved === 'failed') { toast('提交后未出现「下一页」或页面未变化，流程已结束。', 'error', 7000); break; }
                            continue;   // 已确认进入下一题
                        }
                        skippedCount++;
                        stopReason = `第 ${guard} 题 AI 答案未能填入页面`;
                    } else {
                        skippedCount++;
                        stopReason = `大模型对第 ${guard} 题没有返回有效答案`;
                        console.warn('[助手] 大模型未返回有效答案。');
                    }
                } else {
                    stopReason = '当前页面未能提取到题干';
                }

                // 没走到上面的 continue，说明本题没能完成"作答 → 提交 → 下一页"。
                // 按新规则，答题任务不再点页脚 ">" 跳过题目（那等于漏答），所以在本题停住并说明原因。
                toast(`${stopReason}，已停止流程以免用 ">" 跳过题目。可修正后从本题重新开始。`, 'warn', 9000);
                break;
            }

            if (settings.aiSaveToBank && collected.length > 0) {
                const added = updateQuestionBank(collected);
                toast(`AI 答案已写入本地题库：新增 ${added} 题。`, 'success', 6000);
            }

            alert(`大模型作答流程已完成。\n成功作答 ${answeredCount} 题，跳过 ${skippedCount} 题。`);
        } catch (e) {
            console.error('[助手] AI 答题流程异常', e);
            toast('AI 答题流程异常中断：' + (e && e.message ? e.message : e), 'error', 8000);
        } finally {
            if (triggerBtn) triggerBtn.innerText = originalText;
            endAnswerTask();
        }
    }

    // (E) 按当前模式作答
    async function startAnswerByMode() {
        if (getSettings().answerMode === 'ai') await startAnswerFromAI();
        else await startAnswerFromBank();
    }

    function syncAnswerButton() {
        const btn = document.getElementById('answer-from-bank-btn');
        if (!btn) return;
        const mode = getSettings().answerMode;
        btn.innerText = mode === 'ai' ? 'AI作答（大模型）' : '按题库作答';
        btn.style.backgroundColor = mode === 'ai' ? '#6f42c1' : '#17a2b8';
    }

    // ==================== 核心功能 6: 参考资料库（PDF/PPTX/DOCX/TXT/JSON → 切片 → 检索 → 注入提示词） ====================
    // 不整份喂给模型（讲义动辄 31 讲 / 6.5 万字，既超预算又大多与当前题无关），
    // 流程是：文件 → 纯文本 → 定长切片 → 按题干检索 Top-K → 只把最相关的几片接进提示词。
    const PDF_WORKER_URL = 'https://cdn.bootcdn.net/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    function getReference() {
        try {
            const saved = GM_getValue(REFERENCE_KEY, null);
            if (!saved || !Array.isArray(saved.chunks)) return { name: '', chunks: [], totalChars: 0 };
            return saved;
        } catch (e) {
            console.error('[助手] 参考资料读取失败', e);
            return { name: '', chunks: [], totalChars: 0 };
        }
    }

    function saveReference(ref) {
        try { GM_setValue(REFERENCE_KEY, ref); }
        catch (e) {
            console.error('[助手] 参考资料写入失败（可能超出扩展存储上限）', e);
            toast('参考资料保存失败，可能体积过大；请换更小的资料。', 'error', 8000);
        }
        return ref;
    }

    function clearReference() {
        try { GM_setValue(REFERENCE_KEY, { name: '', chunks: [], totalChars: 0 }); } catch (e) { /* ignore */ }
    }

    // 把 [{source, text}] 切成接近 REF_CHUNK_CHARS 的片，片间留 overlap 防止答案正好被切断
    function buildRefChunks(blocks) {
        const chunks = [];
        blocks.forEach((block) => {
            const source = String(block.source || '').trim();
            const text = String(block.text || '')
                .replace(/\r\n?/g, '\n')
                .replace(/[ \t\u00a0]+/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            if (!text) return;

            // 段落优先；单个段落超长再硬切
            const paras = [];
            text.split(/\n{2,}/).forEach((p) => {
                if (p.length <= REF_CHUNK_CHARS) { paras.push(p); return; }
                const step = REF_CHUNK_CHARS - REF_CHUNK_OVERLAP;
                for (let i = 0; i < p.length; i += step) paras.push(p.slice(i, i + REF_CHUNK_CHARS));
            });

            let buf = '';
            const flush = (carry) => {
                const t = buf.trim();
                if (t) chunks.push({ source: source, text: t });
                buf = (carry && t) ? t.slice(-REF_CHUNK_OVERLAP) : '';
            };
            paras.forEach((p) => {
                if (!buf) { buf = p; return; }
                if (buf.length + p.length + 1 <= REF_CHUNK_CHARS) { buf += '\n' + p; return; }
                flush(true);
                buf += p;
            });
            flush(false);
        });
        return chunks;
    }

    // 中文字符级 bigram 检索：无需分词库，对中文/英文混排都够用
    const REF_PUNCT_RE = /[\s\u3000-\u303f\uff00-\uffef.,;:!?()[\]{}<>"'`~@#$%^&*_+=|\\/\-—…、。，；：！？（）【】《》“”‘’]/g;

    function refNormalize(text) {
        return String(text || '').replace(REF_PUNCT_RE, '').toLowerCase();
    }

    function refBigrams(text) {
        const s = refNormalize(text);
        const grams = new Set();
        for (let i = 0; i + 1 < s.length; i++) grams.add(s.slice(i, i + 2));
        if (s.length === 1) grams.add(s);
        return grams;
    }

    // 词频缓存放 WeakMap：不污染存档（GM 存储走 JSON 序列化，把 Set 写进去会存坏），也不用每次重算
    const refGramCache = new WeakMap();
    function chunkGrams(chunk) {
        let g = refGramCache.get(chunk);
        if (!g) { g = refBigrams(chunk.text); refGramCache.set(chunk, g); }
        return g;
    }

    // IDF 索引：像"创业""技术"这种满篇都有的词权重低，像"知识产权""商业模式"这种稀有词权重高；
    // 不做 IDF 时，"降低创业风险"这类判断题会召回"团队文化建设"之类明显无关的讲义。
    let refIndexCache = null;
    function ensureRefIndex(ref) {
        const stamp = String(ref.at || '') + '#' + ref.chunks.length;
        if (refIndexCache && refIndexCache.stamp === stamp) return refIndexCache;
        const df = new Map();
        ref.chunks.forEach((c) => {
            chunkGrams(c).forEach((g) => df.set(g, (df.get(g) || 0) + 1));
        });
        refIndexCache = { stamp: stamp, df: df, total: ref.chunks.length };
        return refIndexCache;
    }

    function scoreRefChunk(queryGrams, chunk, index) {
        const grams = chunkGrams(chunk);
        let score = 0;
        queryGrams.forEach((g) => {
            if (!grams.has(g)) return;
            score += Math.log(1 + index.total / (index.df.get(g) || 1));
        });
        return score;
    }

    function retrieveReference(questionData, topK) {
        const ref = getReference();
        if (!ref.chunks || ref.chunks.length === 0) return [];
        const query = [questionData.stem || '']
            .concat((questionData.optionItems || []).map((it) => it.text))
            .join(' ');
        const queryGrams = refBigrams(query);
        if (queryGrams.size === 0) return [];

        const index = ensureRefIndex(ref);
        const scored = ref.chunks.map((c) => ({ chunk: c, score: scoreRefChunk(queryGrams, c, index) }));
        scored.sort((a, b) => b.score - a.score);

        const best = scored.length > 0 ? scored[0].score : 0;
        if (best <= 0) return [];
        const floor = best * REF_MIN_RATIO;   // 明显弱于最佳片的直接丢掉，别把噪声当资料喂给模型

        const picked = [];
        let used = 0;
        const k = topK || REF_TOP_K;
        for (const item of scored) {
            if (item.score < floor || picked.length >= k) break;
            if (picked.length > 0 && used + item.chunk.text.length > REF_MAX_CHARS) continue;
            picked.push(item);
            used += item.chunk.text.length;
        }
        return picked;
    }

    function buildReferenceContext(questionData) {
        if (!getSettings().refEnabled) return '';
        const ref = getReference();
        if (!ref.chunks || ref.chunks.length === 0) return '';
        const picked = retrieveReference(questionData);
        if (picked.length === 0) return '';
        const body = picked.map((p, i) => {
            const tag = p.chunk.source ? '【' + p.chunk.source + '】' : '';
            return '(资料' + (i + 1) + ')' + tag + '\n' + p.chunk.text;
        }).join('\n\n');
        return '参考资料（来自你上传的《' + (ref.name || '参考资料') + '》，按相关度检索，可能不完整；'
            + '若能据此确定答案请优先采用，若资料与题目无关则忽略它并凭常识作答）：\n' + body;
    }

    // ---------- 文件读取 ----------
    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsText(file, 'utf-8');
        });
    }

    function readFileAsArrayBuffer(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsArrayBuffer(file);
        });
    }

    function getPdfJs() {
        try { if (typeof pdfjsLib !== 'undefined' && pdfjsLib) return pdfjsLib; } catch (e) { /* ignore */ }
        if (window.pdfjsLib) return window.pdfjsLib;
        return null;
    }

    async function extractPdfBlocks(file) {
        const lib = getPdfJs();
        if (!lib) throw new Error('PDF 解析库(pdf.js)未加载，请改用 TXT / JSON 格式的讲义');
        try { lib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL; } catch (e) { /* ignore */ }
        const buf = await readFileAsArrayBuffer(file);
        const pdf = await lib.getDocument({ data: buf }).promise;
        const blocks = [];
        for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            const text = content.items.map((it) => it.str || '').join(' ').replace(/\s+/g, ' ').trim();
            if (text) blocks.push({ source: file.name + ' p' + p, text: text });
        }
        return blocks;
    }

    function blocksFromJson(raw, name) {
        let data = null;
        try { data = JSON.parse(raw); }
        catch (e) { throw new Error('JSON 解析失败：' + (e && e.message ? e.message : e)); }
        const blocks = [];
        const pushRecord = (rec) => {
            if (rec == null) return;
            if (typeof rec === 'string') { blocks.push({ source: name, text: rec }); return; }
            const text = rec.text || rec.content || rec.body || '';
            if (!String(text).trim()) return;
            const label = rec.lecture
                ? (rec.lecture + (rec.slide ? ' slide' + rec.slide : ''))
                : (rec.source || name);
            blocks.push({ source: label, text: String(text) });
        };
        if (Array.isArray(data)) data.forEach(pushRecord);
        else if (data && Array.isArray(data.chunks)) data.chunks.forEach(pushRecord);
        else if (typeof data === 'string') blocks.push({ source: name, text: data });
        else if (data && typeof data === 'object') {
            Object.keys(data).forEach((k) => blocks.push({ source: k, text: String(data[k]) }));
        }
        return blocks;
    }

    // 识别 "===== 讲义标题 =====" / "# 标题" 这类分隔，把标题当作来源标注
    function blocksFromText(raw, name) {
        const blocks = [];
        let source = name;
        let buf = [];
        const flush = () => {
            const t = buf.join('\n').trim();
            if (t) blocks.push({ source: source, text: t });
            buf = [];
        };
        String(raw).replace(/\r\n?/g, '\n').split('\n').forEach((line) => {
            const m = line.match(/^\s*=====\s*(.+?)\s*=====\s*$/) || line.match(/^\s*#{1,3}\s+(.+?)\s*$/);
            if (m) { flush(); source = m[1]; return; }
            buf.push(line);
        });
        flush();
        return blocks;
    }

    // ---------- PPTX / DOCX（OOXML 就是 zip：解包后从 XML 里抽文字）----------
    // 用户讲义常是 .pptx，而旧版文件选择框只 accept=".pdf,.txt,…" 会把 PPTX 在文件对话框里过滤掉
    // （现象："选资料时在文件夹里找不到资料"）。现在既放开过滤，也真把 PPTX/DOCX 文本抽出来当参考资料。

    // 从 OOXML 里按段落抽文本：pptx 用 a:p / a:t，docx 用 w:p / w:t
    function ooxmlParagraphs(xml, paraTag, runTag) {
        const out = [];
        let doc = null;
        try { doc = new DOMParser().parseFromString(xml, 'application/xml'); }
        catch (e) { return out; }
        if (!doc) return out;
        const paras = doc.getElementsByTagName(paraTag);
        for (let i = 0; i < paras.length; i++) {
            const runs = paras[i].getElementsByTagName(runTag);
            let line = '';
            for (let j = 0; j < runs.length; j++) line += (runs[j].textContent || '');
            line = line.replace(/\s+/g, ' ').trim();
            if (line) out.push(line);
        }
        return out;
    }

    // ---- 内置最小 ZIP 读取（OOXML 用）----
    // 不用 JSZip 的原因：在 Tampermonkey(MV3) 沙箱里它的 loadAsync 会一直不 settle（既不报错也不完成，
    //   状态栏停在"正在解析…"，同一份 PPTX 在页面世界却跑得好）。改成只用浏览器自带的
    //   DecompressionStream('deflate-raw') 自己读 ZIP 中央目录：零依赖、不联网，
    //   而且只解压需要的条目（幻灯片 XML），不把整份 pptx 全解开。
    const ZIP_CEN_SIG = 0x02014b50;

    function findZipEOCD(u8) {
        const min = Math.max(0, u8.length - 65558);
        for (let i = u8.length - 22; i >= min; i--) {
            if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) return i;
        }
        return -1;
    }

    async function inflateRawBytes(bytes) {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('当前浏览器不支持 DecompressionStream，无法解包 PPTX/DOCX（请升级浏览器，或把讲义另存为 PDF/TXT）');
        }
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function readZipTextEntries(file, nameRe) {
        const ab = await readFileAsArrayBuffer(file);
        const u8 = new Uint8Array(ab);
        const eocd = findZipEOCD(u8);
        if (eocd < 0) throw new Error('不是有效的 PPTX/DOCX（找不到 ZIP 结束记录）');
        const dv = new DataView(ab);
        const count = dv.getUint16(eocd + 10, true);
        let off = dv.getUint32(eocd + 16, true);
        const decoder = new TextDecoder('utf-8');
        const out = [];
        for (let i = 0; i < count && off + 46 <= u8.length; i++) {
            if (dv.getUint32(off, true) !== ZIP_CEN_SIG) break;
            const method = dv.getUint16(off + 10, true);
            const compSize = dv.getUint32(off + 20, true);
            const nameLen = dv.getUint16(off + 28, true);
            const extraLen = dv.getUint16(off + 30, true);
            const commentLen = dv.getUint16(off + 32, true);
            const localOff = dv.getUint32(off + 42, true);
            const name = decoder.decode(u8.subarray(off + 46, off + 46 + nameLen));
            if (nameRe.test(name)) {
                // 本地文件头长度可能与中央目录不同（extra 字段会变），所以按本地头算数据起点
                const lNameLen = dv.getUint16(localOff + 26, true);
                const lExtraLen = dv.getUint16(localOff + 28, true);
                const dataStart = localOff + 30 + lNameLen + lExtraLen;
                const raw = u8.subarray(dataStart, dataStart + compSize);
                const bytes = method === 0 ? raw : await inflateRawBytes(raw);
                out.push({ name: name, text: decoder.decode(bytes) });
            }
            off += 46 + nameLen + extraLen + commentLen;
        }
        return out;
    }

    async function extractPptxBlocks(file) {
        const entries = await readZipTextEntries(file, /^ppt\/slides\/slide\d+\.xml$/i);
        if (entries.length === 0) throw new Error('PPTX 里没有找到幻灯片文本（ppt/slides/slideN.xml）');
        entries.sort((a, b) => (parseInt((a.name.match(/(\d+)/) || [0, 0])[1], 10) - parseInt((b.name.match(/(\d+)/) || [0, 0])[1], 10)));
        const blocks = [];
        entries.forEach((en) => {
            const text = ooxmlParagraphs(en.text, 'a:p', 'a:t').join('\n').trim();
            if (!text) return;
            const no = (en.name.match(/(\d+)/) || [0, '?'])[1];
            blocks.push({ source: file.name + ' 第' + no + '页', text: text });
        });
        return blocks;
    }

    async function extractDocxBlocks(file) {
        const entries = await readZipTextEntries(file, /^word\/document\.xml$/i);
        if (entries.length === 0) throw new Error('DOCX 里没有 word/document.xml（文件可能已损坏）');
        const blocks = [];
        entries.forEach((en) => {
            const text = ooxmlParagraphs(en.text, 'w:p', 'w:t').join('\n').trim();
            if (text) blocks.push({ source: file.name, text: text });
        });
        return blocks;
    }

    // 一份文件 → [{source, text}]
    async function extractBlocksFromFile(file) {
        const name = file.name || 'reference';
        const lower = name.toLowerCase();
        if (lower.endsWith('.pdf')) return await extractPdfBlocks(file);
        if (lower.endsWith('.pptx')) return await extractPptxBlocks(file);
        if (lower.endsWith('.docx')) return await extractDocxBlocks(file);
        if (lower.endsWith('.ppt') || lower.endsWith('.doc')) {
            throw new Error('旧版 .ppt/.doc 二进制格式不支持，请另存为 PPTX / DOCX 或 PDF');
        }
        if (lower.endsWith('.json')) return blocksFromJson(await readFileAsText(file), name);
        return blocksFromText(await readFileAsText(file), name);
    }

    // 参考资料总字数上限：再多检索也只会稀释相关度，还会把存档撑大
    const REF_MAX_TOTAL_CHARS = 400000;

    // 可以一次选多份资料：同名文件按"替换"处理，不同文件按顺序合并，超出上限从最早的开始裁
    async function ingestReferenceFiles(fileList, statusEl) {
        const files = Array.prototype.slice.call(fileList || []);
        if (files.length === 0) return null;
        const setStatus = (t) => { if (statusEl) statusEl.innerText = t; };
        const prev = getReference();
        let chunks = Array.isArray(prev.chunks) ? prev.chunks.slice() : [];
        const loaded = [];
        const skipped = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            setStatus(`正在解析 ${file.name}（${i + 1}/${files.length}）...`);
            let blocks = [];
            try { blocks = await extractBlocksFromFile(file); }
            catch (e) {
                console.error('[助手] 参考资料解析失败', file.name, e);
                skipped.push(file.name + '：' + (e && e.message ? e.message : e));
                continue;
            }
            const adding = buildRefChunks(blocks).map((c) => Object.assign({ file: file.name }, c));
            if (adding.length === 0) { skipped.push(file.name + '：没有提取到文字（扫描版 PDF 需要先 OCR）'); continue; }
            // 同一份文件再次选择 = 替换它旧的内容，而不是叠加
            chunks = chunks.filter((c) => c.file !== file.name).concat(adding);
            loaded.push({ name: file.name, chunks: adding.length });
        }

        let totalChars = chunks.reduce((n, c) => n + c.text.length, 0);
        if (totalChars > REF_MAX_TOTAL_CHARS) {
            while (chunks.length > 1 && totalChars > REF_MAX_TOTAL_CHARS) totalChars -= chunks.shift().text.length;
            skipped.push(`总字数超出上限，已裁剪到约 ${Math.round(REF_MAX_TOTAL_CHARS / 1000)}k 字`);
        }
        if (chunks.length === 0) {
            throw new Error(skipped.length ? skipped.join('；') : '没有提取到任何文字');
        }

        const parts = loaded.map((l) => l.name + '(' + l.chunks + '片)');
        // 名称按"当前存档里实际有哪些文件"来写，而不是只写这一次选的文件（多次追加时更清楚）
        const allFiles = Array.from(new Set(chunks.map((c) => c.file).filter(Boolean)));
        const name = allFiles.length > 3
            ? (allFiles.slice(0, 3).join('、') + ' 等 ' + allFiles.length + ' 份')
            : (allFiles.length ? allFiles.join('、') : parts.join('、'));
        saveReference({ name: name || prev.name, chunks: chunks, totalChars: totalChars, at: new Date().toISOString() });
        return { name: name, chunks: chunks.length, totalChars: totalChars, loaded: loaded, skipped: skipped };
    }

    // ==================== 核心功能 7: AI 视觉识图（题干/选项里的图片） ====================
    // 题目配图是跨域的：fetch() 被 CORS 拦（Failed to fetch），canvas.drawImage + toDataURL 会因画布
    //   taint 抛 SecurityError。只有 GM_xmlhttpRequest（不受 CORS 限制）能取到图，再自己转 base64。
    function collectQuestionImageUrls() {
        const scope = q('.question') || document;
        const urls = [];
        qa('img', scope).forEach((im) => {
            const src = im.currentSrc || im.src || '';
            if (!/^https?:/i.test(src)) return;                 // 跳过 data: / blob: / 相对路径
            if (/logo|avatar|icon|sprite|qrcode/i.test(src)) return;
            const w = im.naturalWidth || Math.round(im.getBoundingClientRect().width);
            const h = im.naturalHeight || Math.round(im.getBoundingClientRect().height);
            if (w && h && w < 8 && h < 8) return;               // 忽略极小装饰图
            if (!urls.includes(src)) urls.push(src);
        });
        return urls.slice(0, VISION_MAX_IMAGES);
    }

    // 图床把 PNG 当 application/octet-stream 返回，直接把声明的 content-type 透传给接口会被拒
    // （"unsupported image … only webp, png, jpeg, gif"），所以先按文件头魔数嗅探真实格式。
    function sniffImageMime(bytes, headers) {
        const b = bytes;
        if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
        if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
        if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
        if (b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
        const m = String(headers || '').match(/content-type:\s*([^\s;]+)/i);
        if (m && /^image\//i.test(m[1])) return m[1];
        return 'image/png';
    }

    function fetchBinaryAsDataURL(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('GM_xmlhttpRequest 不可用')); return; }
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'arraybuffer',
                timeout: 20000,
                onload: (res) => {
                    try {
                        if (res.status && (res.status < 200 || res.status >= 300)) { reject(new Error('HTTP ' + res.status)); return; }
                        const buf = res.response;
                        if (!buf || !buf.byteLength) { reject(new Error('空响应')); return; }
                        if (buf.byteLength > VISION_MAX_IMAGE_BYTES) { reject(new Error('图片过大 ' + buf.byteLength + 'B')); return; }
                        const bytes = new Uint8Array(buf);
                        const type = sniffImageMime(bytes, res.responseHeaders);
                        let bin = '';
                        const STEP = 0x8000;   // 分块避免 apply 参数过多
                        for (let i = 0; i < bytes.length; i += STEP) {
                            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
                        }
                        resolve('data:' + type + ';base64,' + btoa(bin));
                    } catch (e) { reject(e); }
                },
                onerror: () => reject(new Error('图片下载失败（跨域或网络问题）')),
                ontimeout: () => reject(new Error('图片下载超时'))
            });
        });
    }

    async function collectQuestionImages() {
        const images = [];
        for (const url of collectQuestionImageUrls()) {
            try {
                const dataUrl = await fetchBinaryAsDataURL(url);
                images.push({ url: url, dataUrl: dataUrl });
                console.log('[助手] 视觉：已取回题目图片', url, '(' + dataUrl.length + ' chars)');
            } catch (e) {
                console.warn('[助手] 视觉：题目图片取回失败', url, e && e.message ? e.message : e);
            }
        }
        return images;
    }

    // ==================== 结果格式化 / 导出 ====================
    function sortExtractedData(data) {
        const typePriority = { '单选题': 1, '多选题': 2, '判断题': 3, '填空题': 4, '简答题': 5, '名词解释': 6, '论述题': 7, '计算题': 8, '未知题型': 99 };
        data.sort((a, b) => {
            const aP = typePriority[a.type] || 99;
            const bP = typePriority[b.type] || 99;
            if (aP !== bP) return aP - bP;
            if (a.sortKey[0] !== b.sortKey[0]) return a.sortKey[0] - b.sortKey[0];
            return a.sortKey[1] - b.sortKey[1];
        });
        return data.some(item => item.sortKey[0] !== 999);
    }

    function formatResults(data) {
        let resultText = `共提取到 ${data.length} 道题目：\n\n`;
        let lastType = '';
        data.forEach((item) => {
            if (item.type !== lastType) {
                resultText += `--- ${item.type} ---\n\n`;
                lastType = item.type;
            }
            resultText += `${item.stem}\n\n`;
            (item.options || []).forEach(opt => { resultText += `${opt}\n`; });
            resultText += `\n正确答案: ${item.answer}\n`;
            resultText += '\n' + '='.repeat(40) + '\n\n';
        });
        return resultText;
    }

    function getUsername() {
        try {
            const userElement = q('div.sys-menu .user-name');
            if (userElement) return (userElement.innerText || '').replace(/Hi[～~!！]?\s*/, '').trim() || 'unknown_user';
            return 'unknown_user';
        } catch (e) {
            console.error('获取用户名时出错:', e);
            return 'error_user';
        }
    }

    function exportDataAsJSON(data) {
        const dataToExport = data.map(({ sortKey, stemKey, ...rest }) => rest);
        const jsonString = JSON.stringify(dataToExport, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        let chapterNum = '未知章节';
        if (data.length > 0 && data[0].sortKey && data[0].sortKey[0] !== 999) chapterNum = data[0].sortKey[0];
        a.download = `学堂在线题库_${chapterNum}_${getUsername()}_${data.length}.json`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {                       // 延后释放，避免下载被中断
            if (a.parentNode) a.parentNode.removeChild(a);
            window.URL.revokeObjectURL(url);
        }, 3000);
    }

    function showResultModal(data) {
        const resultText = formatResults(data);
        if (document.getElementById('result-modal-overlay')) document.getElementById('result-modal-overlay').remove();
        const overlay = document.createElement('div');
        overlay.id = 'result-modal-overlay';
        const modalContent = document.createElement('div');
        modalContent.id = 'result-modal-content';
        const closeBtn = document.createElement('span');
        closeBtn.id = 'modal-close-btn';
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = function () { overlay.remove(); };
        const title = document.createElement('h3');
        const sorted = data.some(item => item.sortKey[0] !== 999);
        title.innerText = sorted ? '题目提取结果汇总 (已按题型/题号排序)' : '题目提取结果汇总 (按题型分组，未能解析题号)';
        title.style.margin = '0 0 15px 0';
        const buttonContainer = document.createElement('div');
        const copyBtn = document.createElement('button');
        copyBtn.id = 'modal-copy-btn';
        copyBtn.className = 'modal-btn';
        copyBtn.innerText = '复制到剪贴板';
        copyBtn.onclick = function () {
            try {
                if (typeof GM_setClipboard === 'function') GM_setClipboard(resultText);
                else navigator.clipboard.writeText(resultText);
                copyBtn.innerText = '已复制!';
            } catch (e) {
                copyBtn.innerText = '复制失败';
            }
            setTimeout(() => { copyBtn.innerText = '复制到剪贴板'; }, 2000);
        };
        const exportBtn = document.createElement('button');
        exportBtn.id = 'modal-export-btn';
        exportBtn.className = 'modal-btn';
        exportBtn.innerText = '导出为JSON';
        exportBtn.onclick = function () { exportDataAsJSON(data); };
        buttonContainer.appendChild(copyBtn);
        buttonContainer.appendChild(exportBtn);
        const textArea = document.createElement('textarea');
        textArea.id = 'result-textarea';
        textArea.value = resultText;
        textArea.readOnly = true;
        modalContent.appendChild(closeBtn);
        modalContent.appendChild(title);
        modalContent.appendChild(buttonContainer);
        modalContent.appendChild(textArea);
        overlay.appendChild(modalContent);
        getMountRoot().appendChild(overlay);
    }

    function runSinglePageExtract() {
        const data = scrapeCurrentPageData();
        if (data.length === 0) { alert('在当前页面未找到符合条件的题目。'); return; }
        const added = updateQuestionBank(data);
        sortExtractedData(data);
        showResultModal(data);
        toast(`当前页提取 1 题，题库新增 ${added} 题。`, 'success', 4000);
    }

    async function returnToFirstQuestion() {
        if (!beginAnswerTask()) return;
        const returnBtn = document.getElementById('return-first-btn');
        const originalText = returnBtn ? returnBtn.innerText : '';
        try {
            let guard = 0;
            while (guard++ < 200) {
                const pageInfo = getPageNumbers();
                if (!pageInfo.current || pageInfo.current === 1) break;
                if (returnBtn) returnBtn.innerText = `正在返回... ${pageInfo.current}`;
                const prevIcon = q('.tabbar i.iconfont.left') || qa('.tabbar i.iconfont')[0];
                if (prevIcon && !prevIcon.classList.contains('unselect')) {
                    const oldPageNum = pageInfo.current;
                    dispatchClick(prevIcon);
                    const ok = await waitForPageChange(oldPageNum, 'backward');
                    if (!ok) { toast('返回上一题失败或超时。', 'error', 5000); break; }
                } else break;
            }
        } catch (e) {
            console.error('[助手] 返回第一题异常', e);
        } finally {
            if (returnBtn) returnBtn.innerText = originalText;
            endAnswerTask();
        }
    }

    // ==================== UI 初始化 ====================
    function buildField(labelText, control) {
        const field = document.createElement('label');
        field.className = 'panel-field';
        field.appendChild(document.createTextNode(labelText));
        field.appendChild(control);
        return field;
    }

    function initializeControls() {
        if (document.getElementById('control-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'control-panel';

        // 拖动标题栏：按住即可把面板拖到任意位置，双击复位到右下角
        const dragHandle = document.createElement('div');
        dragHandle.id = 'panel-drag-handle';
        dragHandle.title = '按住拖动面板 · 双击恢复右下角';
        const dragTitle = document.createElement('span');
        dragTitle.className = 'panel-title';
        dragTitle.innerText = '学堂在线助手 V4.3';
        const dragGrip = document.createElement('span');
        dragGrip.className = 'panel-grip';
        dragGrip.innerText = '⠿ 拖动';
        dragHandle.appendChild(dragTitle);
        dragHandle.appendChild(dragGrip);
        attachPanelDrag(panel, dragHandle);

        const autoVideoBtn = document.createElement('button');
        autoVideoBtn.id = 'auto-video-btn';
        autoVideoBtn.className = 'extractor-btn';
        autoVideoBtn.innerText = '自动刷课';
        autoVideoBtn.addEventListener('click', toggleVideoAutoplay);

        const rateSelect = document.createElement('select');
        rateSelect.id = 'playback-rate-select';
        rateSelect.className = 'extractor-select';
        [1, 1.25, 1.5, 2].forEach(rate => {
            const option = document.createElement('option');
            option.value = String(rate);
            option.textContent = rate === 1 ? '1.0x（默认）' : rate + 'x';
            rateSelect.appendChild(option);
        });
        rateSelect.value = String(getSettings().playbackRate);
        rateSelect.addEventListener('change', () => {
            saveSettings({ playbackRate: parseFloat(rateSelect.value) });
            console.log(`刷课: 播放倍速已切换为 ${rateSelect.value}x（下一轮巡检生效）`);
        });

        const autoNextCheck = document.createElement('input');
        autoNextCheck.type = 'checkbox';
        autoNextCheck.id = 'auto-next-check';
        autoNextCheck.checked = !!getSettings().autoNext;
        autoNextCheck.addEventListener('change', () => {
            saveSettings({ autoNext: autoNextCheck.checked });
            toast(autoNextCheck.checked
                ? '已开启自动翻页：仅在检测到当前单元"已完成"时才会翻到下一单元。'
                : '已关闭自动翻页，结束单元后请手动翻页。', 'info', 5000);
        });
        const autoNextField = document.createElement('label');
        autoNextField.className = 'panel-field checkbox-field';
        autoNextField.appendChild(autoNextCheck);
        autoNextField.appendChild(document.createTextNode('允许自动翻页'));

        // 选中选项后自动点「提交」：默认开启，随时可关
        const autoSubmitCheck = document.createElement('input');
        autoSubmitCheck.type = 'checkbox';
        autoSubmitCheck.id = 'auto-submit-check';
        autoSubmitCheck.checked = !!getSettings().autoSubmitOnSelect;
        autoSubmitCheck.addEventListener('change', () => {
            saveSettings({ autoSubmitOnSelect: autoSubmitCheck.checked });
            resetAutoSubmitPending();
            autoSubmitState.doneSig = null;
            autoSubmitState.blocked = null;
            toast(autoSubmitCheck.checked
                ? '已开启：选中选项后脚本会自动点「提交」（提交后不能改答案）。'
                : '已关闭：选完选项请自己点「提交」。', 'info', 5000);
        });
        const autoSubmitField = document.createElement('label');
        autoSubmitField.className = 'panel-field checkbox-field';
        autoSubmitField.appendChild(autoSubmitCheck);
        autoSubmitField.appendChild(document.createTextNode('选中选项后自动提交'));

        const modeSelect = document.createElement('select');
        modeSelect.id = 'answer-mode-select';
        modeSelect.className = 'extractor-select';
        [['bank', '题库作答'], ['ai', '大模型(AI)作答']].forEach(([value, label]) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            modeSelect.appendChild(option);
        });
        modeSelect.value = getSettings().answerMode;
        modeSelect.addEventListener('change', () => {
            saveSettings({ answerMode: modeSelect.value });
            syncAnswerButton();
            console.log(`答题模式已切换为: ${modeSelect.value === 'ai' ? '大模型(AI)作答' : '题库作答'}`);
        });

        const aiBox = document.createElement('details');
        aiBox.id = 'ai-config-box';
        aiBox.className = 'panel-details';
        const aiSummary = document.createElement('summary');
        aiSummary.innerText = 'AI 配置';
        aiBox.appendChild(aiSummary);

        const aiUrlInput = document.createElement('input');
        aiUrlInput.id = 'ai-api-url';
        aiUrlInput.className = 'extractor-input';
        aiUrlInput.placeholder = 'AI API 地址';
        aiUrlInput.value = getSettings().aiApiUrl;

        const aiModelInput = document.createElement('input');
        aiModelInput.id = 'ai-model';
        aiModelInput.className = 'extractor-input';
        aiModelInput.placeholder = '模型名称（如 deepseek-flash）';
        aiModelInput.setAttribute('list', 'ai-model-options');   // 下拉给出接口实际支持的模型名，避免填错导致 HTTP 400
        aiModelInput.value = getSettings().aiModel;

        const aiModelOptions = document.createElement('datalist');
        aiModelOptions.id = 'ai-model-options';
        SUPPORTED_AI_MODELS.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            aiModelOptions.appendChild(option);
        });

        const aiKeyInput = document.createElement('input');
        aiKeyInput.id = 'ai-api-key';
        aiKeyInput.className = 'extractor-input';
        aiKeyInput.type = 'password';
        aiKeyInput.placeholder = 'AI API 密钥 (sk-...)';
        aiKeyInput.value = getSettings().aiApiKey;

        const saveAiBtn = document.createElement('button');
        saveAiBtn.id = 'save-ai-config-btn';
        saveAiBtn.className = 'extractor-btn';
        saveAiBtn.innerText = '保存 AI 配置';
        saveAiBtn.addEventListener('click', () => {
            const fixedUrl = normalizeApiUrl(aiUrlInput.value);
            if (fixedUrl && fixedUrl !== aiUrlInput.value.trim()) aiUrlInput.value = fixedUrl;   // 自动补全 /v1/chat/completions
            saveSettings({
                aiApiUrl: fixedUrl,
                aiModel: aiModelInput.value.trim() || DEFAULT_AI_MODEL,
                aiApiKey: aiKeyInput.value.trim()
            });
            toast('AI 配置已保存，建议点「测试连接」确认可用。', 'success', 5000);
        });

        const testAiBtn = document.createElement('button');
        testAiBtn.id = 'test-ai-btn';
        testAiBtn.className = 'extractor-btn';
        testAiBtn.innerText = '测试连接';
        testAiBtn.addEventListener('click', () => { testAIConnection(true); });

        const aiBankCheck = document.createElement('input');
        aiBankCheck.type = 'checkbox';
        aiBankCheck.id = 'ai-save-bank-check';
        aiBankCheck.checked = !!getSettings().aiSaveToBank;
        aiBankCheck.addEventListener('change', () => {
            saveSettings({ aiSaveToBank: aiBankCheck.checked });
            toast(aiBankCheck.checked
                ? '已开启：AI 作答成功后会同时写入本地题库（仅新增，不覆盖已有题目）。'
                : '已关闭：AI 答案不会写入本地题库。', 'info', 5000);
        });
        const aiBankField = document.createElement('label');
        aiBankField.className = 'panel-field checkbox-field';
        aiBankField.appendChild(aiBankCheck);
        aiBankField.appendChild(document.createTextNode('AI 答案写入题库'));

        const keyHint = document.createElement('div');
        keyHint.className = 'panel-hint';
        keyHint.innerText = '提示：密钥以明文保存在本机脚本存储中，且题目文本会发送到你填写的 API 地址，请自行确认可信度。保存后建议先点「测试连接」。';

        aiBox.appendChild(aiUrlInput);
        aiBox.appendChild(aiModelInput);
        aiBox.appendChild(aiModelOptions);
        aiBox.appendChild(aiKeyInput);
        aiBox.appendChild(saveAiBtn);
        aiBox.appendChild(testAiBtn);
        aiBox.appendChild(aiBankField);
        aiBox.appendChild(keyHint);

        // ---------- 参考资料库 ----------
        const refBox = document.createElement('details');
        refBox.id = 'ref-config-box';
        refBox.className = 'panel-details';
        const refSummary = document.createElement('summary');
        refSummary.innerText = '参考资料（PDF / PPTX / DOCX / TXT / JSON）';
        refBox.appendChild(refSummary);

        const refStatus = document.createElement('div');
        refStatus.id = 'ref-status';
        refStatus.className = 'panel-hint';
        const renderRefStatus = () => {
            const ref = getReference();
            if (!ref.chunks || ref.chunks.length === 0) { refStatus.innerText = '未加载参考资料。'; return; }
            refStatus.innerText = '已加载：' + ref.name + '（' + ref.chunks.length + ' 片 / ' + ref.totalChars + ' 字）';
        };
        renderRefStatus();

        const refFile = document.createElement('input');
        refFile.type = 'file';
        refFile.id = 'ref-file-input';
        refFile.className = 'extractor-input';
        // 不用 accept 过滤扩展名：旧版 accept=".pdf,.txt,…" 会让 PPTX 在系统文件对话框里"看不见"。
        // 任何文件都能选进来，格式交给解析阶段判断，不支持的格式会给明确提示。
        refFile.multiple = true;
        refFile.title = '可选多份：PDF / PPTX / DOCX / TXT / MD / JSON（不限文件类型）';
        refFile.addEventListener('change', async () => {
            const files = refFile.files ? Array.prototype.slice.call(refFile.files) : [];
            if (files.length === 0) return;
            try {
                const info = await ingestReferenceFiles(files, refStatus);
                if (info) {
                    const base = `参考资料已加载 ${info.loaded.length} 份（共 ${info.chunks} 片 / ${info.totalChars} 字）`;
                    const hasSkip = !!(info.skipped && info.skipped.length);
                    toast(hasSkip ? base + '；' + info.skipped[0] : base, hasSkip ? 'warn' : 'success', 9000);
                    if (hasSkip) console.warn('[助手] 部分资料被跳过或裁剪：', info.skipped);
                }
            } catch (e) {
                console.error('[助手] 参考资料解析失败', e);
                toast('参考资料解析失败：' + (e && e.message ? e.message : e), 'error', 10000);
            } finally {
                renderRefStatus();
                refFile.value = '';
            }
        });

        const refEnableCheck = document.createElement('input');
        refEnableCheck.type = 'checkbox';
        refEnableCheck.id = 'ref-enable-check';
        refEnableCheck.checked = !!getSettings().refEnabled;
        refEnableCheck.addEventListener('change', () => {
            saveSettings({ refEnabled: refEnableCheck.checked });
            toast(refEnableCheck.checked ? '已开启：作答时会检索参考资料并注入提示词。' : '已关闭：不再使用参考资料。', 'info', 4000);
        });
        const refEnableField = document.createElement('label');
        refEnableField.className = 'panel-field checkbox-field';
        refEnableField.appendChild(refEnableCheck);
        refEnableField.appendChild(document.createTextNode('作答时使用参考资料'));

        const visionCheck = document.createElement('input');
        visionCheck.type = 'checkbox';
        visionCheck.id = 'vision-enable-check';
        visionCheck.checked = !!getSettings().visionEnabled;
        visionCheck.addEventListener('change', () => {
            saveSettings({ visionEnabled: visionCheck.checked });
            toast(visionCheck.checked ? '已开启：题目里的图片会交给多模态模型识别。' : '已关闭：只发送提取到的文字。', 'info', 4000);
        });
        const visionField = document.createElement('label');
        visionField.className = 'panel-field checkbox-field';
        visionField.appendChild(visionCheck);
        visionField.appendChild(document.createTextNode('识别题目图片(视觉)'));

        const clearRefBtn = document.createElement('button');
        clearRefBtn.id = 'clear-ref-btn';
        clearRefBtn.className = 'extractor-btn';
        clearRefBtn.innerText = '清空参考资料';
        clearRefBtn.addEventListener('click', () => {
            clearReference();
            renderRefStatus();
            toast('参考资料已清空。', 'success', 4000);
        });

        const refHint = document.createElement('div');
        refHint.className = 'panel-hint';
        refHint.innerText = '可一次选多份（PPTX / DOCX / PDF / TXT / MD / JSON 都能解析）。讲义不会整份发给模型：脚本按题干关键词从资料里检索最相关的几片再注入提示词，省 token 也更准。';

        refBox.appendChild(refFile);
        refBox.appendChild(refStatus);
        refBox.appendChild(refEnableField);
        refBox.appendChild(visionField);
        refBox.appendChild(clearRefBtn);
        refBox.appendChild(refHint);

        const singleExtractBtn = document.createElement('button');
        singleExtractBtn.id = 'single-extract-btn';
        singleExtractBtn.className = 'extractor-btn';
        singleExtractBtn.innerText = '提取当前页';
        singleExtractBtn.addEventListener('click', runSinglePageExtract);

        const autoExtractBtn = document.createElement('button');
        autoExtractBtn.id = 'auto-extract-btn';
        autoExtractBtn.className = 'extractor-btn';
        autoExtractBtn.innerText = '自动翻页提取';
        autoExtractBtn.addEventListener('click', () => runAutomation('extract'));

        const autoAnswerBtn = document.createElement('button');
        autoAnswerBtn.id = 'auto-answer-btn';
        autoAnswerBtn.className = 'extractor-btn';
        autoAnswerBtn.innerText = '自动答题并提取';
        autoAnswerBtn.addEventListener('click', () => runAutomation('answer'));

        const answerFromBankBtn = document.createElement('button');
        answerFromBankBtn.id = 'answer-from-bank-btn';
        answerFromBankBtn.className = 'extractor-btn';
        // 建好就给一个默认文案，不再依赖挂载后的 syncAnswerButton() 兜底
        answerFromBankBtn.innerText = getSettings().answerMode === 'ai' ? 'AI作答（大模型）' : '按题库作答';
        answerFromBankBtn.addEventListener('click', startAnswerByMode);

        const returnFirstBtn = document.createElement('button');
        returnFirstBtn.id = 'return-first-btn';
        returnFirstBtn.className = 'extractor-btn';
        returnFirstBtn.innerText = '返回第一题';
        returnFirstBtn.addEventListener('click', returnToFirstQuestion);

        const clearBankBtn = document.createElement('button');
        clearBankBtn.id = 'clear-bank-btn';
        clearBankBtn.className = 'extractor-btn';
        clearBankBtn.innerText = '清空本地题库';
        clearBankBtn.addEventListener('click', clearQuestionBank);

        panel.appendChild(dragHandle);
        panel.appendChild(autoVideoBtn);
        panel.appendChild(buildField('播放倍速', rateSelect));
        panel.appendChild(autoNextField);
        panel.appendChild(autoSubmitField);
        panel.appendChild(buildField('答题模式', modeSelect));
        panel.appendChild(singleExtractBtn);
        panel.appendChild(autoExtractBtn);
        panel.appendChild(autoAnswerBtn);
        panel.appendChild(answerFromBankBtn);
        panel.appendChild(aiBox);
        panel.appendChild(refBox);
        panel.appendChild(returnFirstBtn);
        panel.appendChild(clearBankBtn);

        // 恢复上次拖动保存的位置，并保证不越出当前视口
        const savedPos = getSettings().panelPos;
        if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
            applyPanelPos(panel, savedPos.x, savedPos.y);
        }

        getMountRoot().appendChild(panel);

        // 必须在面板**真正进入 DOM 之后**再做「按钮文案 / 忙碌态」同步：这两个函数用 getElementById 找按钮，
        //   面板还没 appendChild 时拿到 null，于是「AI作答（大模型）」的文字与配色都没写上，
        //   只剩 CSS 里那块青色背景 —— 看上去就是"有一个按键不可见"。
        syncAnswerButton();
        syncBusyState();

        if (!xHelperGuard().panelResize) {
            xHelperGuard().panelResize = true;
            window.addEventListener('resize', syncPanelClamp);
        }
    }

    // 内部状态（不是自检接口、也不是控制台 API）：记录"监听器/定时器是否已装过"，
    // 避免同一页面被重复注入时叠出两套点击监听与两个定时器。
    function xHelperGuard() {
        if (!window.XT_HELPER_INTERNAL) window.XT_HELPER_INTERNAL = {};
        return window.XT_HELPER_INTERNAL;
    }

    // 面板被页面重绘（SPA 路由/框架 re-render）移除时自动补挂
    function ensurePanelMounted() {
        const panel = document.getElementById('control-panel');
        if (!panel) { initializeControls(); return; }
        const root = getMountRoot();
        if (panel.parentElement !== root) root.appendChild(panel);
    }

    // ==================== 启动入口 ====================
    $(document).ready(function () {
        // 「选中选项 → 自动提交」是纯监听器，不依赖面板是否渲染成功，先单独装好
        installAutoSubmitWatcher();
        const tryInit = (attempt) => {
            if (document.querySelector('.xt_video_player') || document.querySelector('.content--xt') || document.querySelector('.tabbar')) {
                initializeControls();
                try {
                    const observer = new MutationObserver(() => ensurePanelMounted());
                    observer.observe(getMountRoot(), { childList: true });
                } catch (e) { /* 观察器不可用时忽略 */ }
                return;
            }
            if (attempt < 10) setTimeout(() => tryInit(attempt + 1), 2000);   // SPA 页面延迟渲染时继续重试
        };
        setTimeout(() => tryInit(0), 2000);
    });

})();
