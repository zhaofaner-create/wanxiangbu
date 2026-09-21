(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.store = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  // 数据层：负责 localStorage 的读写持久化，以及所有模块数据的增删改查。
  // 其他模块（modules/*.js）只通过这里导出的函数操作数据，不直接碰 localStorage。
  //
  // 设计成 createStore(storage) 工厂函数而不是直接的单例，是为了方便测试：
  // 测试时可以注入一个内存里的假 storage，不依赖浏览器环境。
  // 应用运行时使用下面导出的默认单例 `store`，它使用 globalThis.localStorage。

  const { uuid, todayStr, computeNextOccurrence, addDays, shiftMonth } = require("./utils.js");

  const STORAGE_KEY = "faner-app-data";
  const SCHEMA_VERSION = 1;

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      quickNotes: [],
      todayPlan: [],
      studyCourses: [],
      studyAssignments: [],
      studyGoals: [],
      studyCheckins: [],
      studyDailyLogs: [],
      // 每个学习目标每天累计的专注时长（秒），用于"学习时长可视化统计图表"。
      // 注意：这是后加的字段，不能放进 isValidDataShape() 的 required 列表里——
      // 否则老用户本地已有的存档（没有这个字段）在下次打开时会被判定成"数据形状不对"
      // 整体清空重置，这是绝对不能接受的（详见下面 isValidDataShape 的注释）。
      studyTimeLog: [],
      reminders: [],
      mealPlanEntries: [],
      // 常用菜谱库：每个菜谱有名字和食材清单（数量/单位可选），供三餐格子直接选用，
      // 也是"自动生成购物清单"的数据来源。同样是后加字段，不进 isValidDataShape 的 required。
      recipes: [],
      inventoryItems: [],
      shoppingListItems: [],
      // 库存消耗记录：每次"记一次消耗"都会往这里追加一条，供"消耗趋势"统计用。
      // 同样是后加字段，不进 isValidDataShape 的 required。
      inventoryConsumptionLog: [],
      financeTransactions: [],
      financeCategories: ["餐饮", "交通", "日用", "娱乐", "其他"],
      // 汇率表：1 单位该货币 = 多少人民币。这是离线兜底的默认参考值（应用核心功能仍然
      // 不需要联网就能用）；用户可以在"个人记账"里手动改，也可以点"刷新实时汇率"联网
      // 查询一次最新汇率——那是用户主动触发的一次性网络请求，不是自动/后台联网，跟其它
      // 模块"打开就不联网"的承诺不冲突。查询失败（离线/没网）时，就继续用这份手动值，
      // 记账功能完全不受影响。
      financeExchangeRates: { CNY: 1, EUR: 7.8, USD: 7.1, JPY: 0.047, GBP: 9.1, HKD: 0.91 },
      // 上一次成功联网刷新汇率的时间，null 表示还没刷新过（或者一直手动填）。
      financeExchangeRatesUpdatedAt: null,
      // 每个分类的月度预算上限（人民币等值），没设置预算的分类不会出现在"预算超支提醒"里。
      // 多账户支持：每笔记账可以关联一个账户；老数据没有账户概念，init() 时会自动建一个
      // "默认账户"并把老记录都归到它名下，不会凭空丢失归属。以上两个都是后加字段，不进
      // isValidDataShape 的 required。
      financeBudgets: {},
      financeAccounts: [],
      games: [],
      gameSessions: [],
      settings: {
        homeCards: {
          study: true,
          reminders: true,
          meal: true,
          inventory: true,
          finance: true,
          games: true,
        },
        lastBackupAt: null,
        lastManualSaveAt: null,
        // 外观：字体字号（用整页 zoom 缩放实现，不用重写全站的 px 字号）+ 白天/夜间（护眼）主题。
        // 同样是后加字段，不进 isValidDataShape 的 required；见下面 mergeSettingsDefaults 的注释。
        fontScale: "medium",
        theme: "day",
        // 用户自己的昵称/头像，跟"万象簿"这个软件本身的名字是两回事——软件改名之后
        // 侧边栏顶部显示的是软件图标+软件名，这里的 profile 是"用这个软件的人"的身份。
        // avatarImage：用户从相册上传的头像照片，压缩后存成一段 data URL 字符串；
        // 为 null 时表示"没有上传照片，用下面 avatar 这个 emoji"。两者都存着，
        // 上传照片只是优先显示，不会覆盖/丢失用户之前选的 emoji，方便随时切回去。
        profile: { name: "", avatar: "🙂", avatarImage: null },
        // Claude API 密钥：只给「课堂笔记」的"AI 整理笔记"这一个功能用（多语言互译已经
        // 改用下面三家专门的翻译服务，不再用 Claude 翻译）。用户自己去 Anthropic 官网
        // 申请、自己填在这里，只存在这台设备本地，绝不写进代码仓库、也不会发去别的
        // 地方——每个人（包括分享这份App给的朋友）都用自己的密钥、自己那份额度，
        // 不会互相占用、也不会算到别人账上。为空字符串表示还没配置。
        // 字段名沿用了历史上的 translationApiKey（早期版本设计成翻译也用 Claude），
        // mergeSettingsDefaults 里会把老存档的 translationApiKey 自动迁移过来，不会丢失
        // 用户已经填过的密钥。
        claudeApiKey: "",
        // 多语言互译现在接入三家专门的翻译服务，各自的密钥分开存，互不影响；
        // translationProvider 记的是"当前生效用哪一家"，翻译按钮只会调用这一家，
        // 换成另一家随时免费切换，不会多花钱、也不会影响已经翻译好的内容。
        // Azure 这家验证请求时除了密钥还需要"资源区域"，所以单独多一个字段。
        translationProvider: "google",
        googleTranslateApiKey: "",
        azureTranslatorApiKey: "",
        azureTranslatorRegion: "",
        deeplApiKey: "",
        // "整体重新识别"功能用的云端语音转文字服务：跟互译一样是用户自己的密钥、自己付费，
        // 但这里只支持 Google/Azure 两家（没有免费的浏览器内置引擎能处理"已经录好的音频文件"，
        // 详见 speechToTextProviders.js 顶部注释）。语音识别用的密钥跟"多语言互译"的密钥分开存，
        // 即使用户之前把翻译密钥限制成"只能调翻译API"，语音识别这边重新填一份专门开通了
        // 语音转文字权限的密钥也不会互相干扰。Azure 语音资源和 Azure 翻译资源是两种不同的资源，
        // 需要在 Azure 门户里单独新建，所以区域也分开存。
        sttProvider: "google",
        googleSpeechApiKey: "",
        azureSpeechApiKey: "",
        azureSpeechRegion: "",
      },
      // 读书笔记：一本书一条记录（书名/作者/状态/评分/起止日期），notes 是挂在某本书下面的
      // 一条条读书笔记/摘录（可选页码）。两个都是后加的顶层字段，不进 isValidDataShape 的 required。
      books: [],
      bookNotes: [],
      // 课堂笔记：录音+实时转录+多语言互译+AI整理笔记。这是本轮新加的模块，也是后加的
      // 顶层字段，不进 isValidDataShape 的 required（同样的兼容性硬规则）。
      // 注意：这里只存文字数据（转录文本/翻译文本/整理后的笔记），录音音频本身体积大，
      // 不适合塞进 localStorage 的 JSON 里，音频用 IndexedDB 单独存（见
      // js/components/speechRecorder.js），这里的每条笔记只存一个 audioKey 引用它。
      classNotes: [],
      // 课堂笔记的"课程"分组：同一门课上很多次课，每次课是一条 classNotes 记录，
      // classNoteCourses 是"课程"本身（{id, name, createdAt}），classNotes 上的 courseId
      // 指向属于哪门课，没有归到任何课程的笔记 courseId 是 null（界面上归到"未分类"）。
      // 这是后加的顶层字段，同样不进 isValidDataShape 的 required 列表。
      classNoteCourses: [],
    };
  }

  const FONT_SCALES = ["small", "medium", "large", "xlarge"];
  const THEMES = ["day", "night"];
  const AVATAR_OPTIONS = ["🙂", "😺", "🐶", "🦊", "🐼", "🐧", "🦉", "🐢", "🐨", "🌊", "🌿", "⭐"];
  const APP_NAME = "万象簿";
  const BOOK_STATUSES = ["想读", "在读", "读完"];
  // 课堂笔记支持的语言（讲课语言/翻译目标语言公用同一份列表，一个语言可以既是
  // 讲课语言也是翻译目标——比如老师讲法语、翻译成中文和英文两份）。
  const CLASS_NOTE_LANGUAGES = [
    { code: "zh", label: "中文" },
    { code: "en", label: "英语" },
    { code: "fr", label: "法语" },
    { code: "es", label: "西班牙语" },
    { code: "de", label: "德语" },
    { code: "ja", label: "日语" },
    { code: "ko", label: "韩语" },
    { code: "ru", label: "俄语" },
    { code: "pt", label: "葡萄牙语" },
    { code: "it", label: "意大利语" },
  ];
  // 多语言互译可选的三家翻译服务，settings.js 的选择器和 classNotes.js 都会用到这份列表，
  // 集中定义一处，不在两个模块里各写一遍容易写岔。
  const TRANSLATION_PROVIDER_OPTIONS = [
    { code: "google", label: "Google 翻译" },
    { code: "azure", label: "Azure Translator" },
    { code: "deepl", label: "DeepL" },
  ];
  // "整体重新识别"功能可选的语音转文字服务，只有两家（DeepL 不做语音转文字）。
  const STT_PROVIDER_OPTIONS = [
    { code: "google", label: "Google Speech-to-Text" },
    { code: "azure", label: "Azure AI Speech" },
  ];

  /**
   * 把老存档里的 settings 和 defaultState() 里新增的 settings 子字段做一次"深合并"。
   * 光靠 init() 里那句 `{...defaultState(), ...parsed}` 是不够的——那是浅合并，只要老存档
   * 里已经有 settings 这个 key（从第一版就有），parsed.settings 就会把 defaultState().settings
   * 整个替换掉，字体字号/主题/个人资料这些新加的子字段在老存档里根本不存在，会直接变成
   * undefined，而不是拿到默认值。所以 settings 内部要单独再合并一层。
   */
  function mergeSettingsDefaults(parsedSettings) {
    const base = defaultState().settings;
    const incoming = parsedSettings || {};
    return {
      ...base,
      ...incoming,
      homeCards: { ...base.homeCards, ...(incoming.homeCards || {}) },
      profile: { ...base.profile, ...(incoming.profile || {}) },
      // 字段迁移：早期版本里"翻译"和"整理笔记"共用一把密钥，存在 translationApiKey 里；
      // 现在整理笔记单独用 claudeApiKey。老存档如果只有 translationApiKey、还没有
      // claudeApiKey，就把老密钥接过来，用户不用重新填一遍。
      claudeApiKey: incoming.claudeApiKey || incoming.translationApiKey || "",
    };
  }

  /**
   * 校验一份数据是否具备根结构要求的所有字段（导入备份时用）。
   * 重要：这里的 required 列表只应该包含"从第一版就有的"字段。后续版本给 defaultState()
   * 新增的字段（比如 studyTimeLog）绝不能加进来——因为 init() 是靠
   * `{...defaultState(), ...parsed}` 合并来给老存档自动补上新字段的默认值，
   * 如果把新字段也列进 required，老用户本地真实存档（还没有这个字段）就会被
   * 判定成"形状不对"而被整体清空重置成空白状态，这是绝对不能接受的数据丢失。
   */
  function isValidDataShape(data) {
    if (!data || typeof data !== "object") return false;
    const required = [
      "quickNotes", "todayPlan", "studyCourses", "studyAssignments",
      "studyGoals", "studyCheckins", "studyDailyLogs", "reminders",
      "mealPlanEntries", "inventoryItems", "shoppingListItems",
      "financeTransactions", "financeCategories", "games", "gameSessions", "settings",
    ];
    return required.every((key) => Object.prototype.hasOwnProperty.call(data, key));
  }

  function createStore(storage) {
    let state = defaultState();

    function persist() {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function init() {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) {
        state = defaultState();
        persist();
        rolloverUnfinishedTodayPlan();
        ensureDefaultAccount();
        return state;
      }
      try {
        const parsed = JSON.parse(raw);
        if (isValidDataShape(parsed)) {
          state = { ...defaultState(), ...parsed };
          state.settings = mergeSettingsDefaults(parsed.settings);
          // 汇率表也要做跟 settings 一样的"深合并"：老存档如果只存了 CNY/EUR/USD 三种
          // （在新增日元/英镑/港币之前存的档），直接整个覆盖会导致新币种完全没有汇率、
          // convertToCNY 兜底成 1:1，记账金额会算错很多。用默认值把缺的币种补上，
          // 老存档里已经手动改过的汇率（哪怕是 CNY/EUR/USD 这几个）保持不变。
          state.financeExchangeRates = { ...defaultState().financeExchangeRates, ...(parsed.financeExchangeRates || {}) };
        } else {
          state = defaultState();
          persist();
        }
      } catch {
        state = defaultState();
        persist();
      }
      rolloverUnfinishedTodayPlan();
      ensureDefaultAccount();
      return state;
    }

    function getState() {
      return structuredClone(state);
    }

    // ---------- 快速备忘 ----------
    function addQuickNote(text) {
      const note = { id: uuid(), text, createdAt: new Date().toISOString() };
      state.quickNotes.push(note);
      persist();
      return note;
    }
    function removeQuickNote(id) {
      state.quickNotes = state.quickNotes.filter((n) => n.id !== id);
      persist();
    }
    function listQuickNotes() {
      return [...state.quickNotes].sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
    }

    // ---------- 今日计划 ----------
    const PRIORITY_LEVELS = ["高", "中", "低"];

    function addTodayPlanItem({
      text, time = null, date = todayStr(), source = "manual", sourceId = null,
      estimatedMinutes = null, priority = "中", note = "",
    }) {
      const item = {
        id: uuid(), date, text, time, done: false, source, sourceId,
        estimatedMinutes: estimatedMinutes ? Number(estimatedMinutes) : null,
        priority: PRIORITY_LEVELS.includes(priority) ? priority : "中",
        note: note || "",
        // 计时相关（见 startTodayPlanTimer 等函数）：elapsedSeconds 是已累计的用时，
        // timerStartedAt 非空表示计时器当前正在跑（其值是本段计时开始的时间戳）。
        elapsedSeconds: 0,
        timerStartedAt: null,
        satisfaction: null,
        createdAt: new Date().toISOString(),
      };
      state.todayPlan.push(item);
      persist();
      return item;
    }

    function findTodayPlanItem(id) {
      return state.todayPlan.find((t) => t.id === id) || null;
    }

    /** 编辑今日计划某一项的基础字段（内容/日期/时间点/预计用时/优先度/备注）。 */
    function updateTodayPlanItem(id, patch) {
      const item = findTodayPlanItem(id);
      if (!item) return null;
      if (patch.text !== undefined) item.text = patch.text;
      if (patch.date !== undefined) item.date = patch.date;
      if (patch.time !== undefined) item.time = patch.time;
      if (patch.note !== undefined) item.note = patch.note;
      if (patch.estimatedMinutes !== undefined) {
        item.estimatedMinutes = patch.estimatedMinutes ? Number(patch.estimatedMinutes) : null;
      }
      if (patch.priority !== undefined && PRIORITY_LEVELS.includes(patch.priority)) {
        item.priority = patch.priority;
      }
      persist();
      return { ...item };
    }

    /** 判断某个关联条目对应的"源记录"当前是否已完成/已处理。 */
    function sourceIsComplete(item) {
      if (item.source === "study") {
        const a = state.studyAssignments.find((x) => x.id === item.sourceId);
        return !!a && a.status === "已完成";
      }
      if (item.source === "reminder") {
        const r = state.reminders.find((x) => x.id === item.sourceId);
        if (!r) return false;
        if (r.repeat !== "none") return false; // 周期性提醒没有"完成"概念
        return r.status === "done";
      }
      return false;
    }

    /** 给可能是旧数据（缺新字段）的今日计划条目补上默认值，避免界面读到 undefined。 */
    function withTodayPlanDefaults(t) {
      return {
        priority: "中", note: "", estimatedMinutes: null,
        elapsedSeconds: 0, timerStartedAt: null, satisfaction: null,
        rolledFrom: null,
        ...t,
      };
    }

    function listTodayPlan(date = todayStr()) {
      return state.todayPlan
        .filter((t) => t.date === date)
        .map((t) => ({ ...withTodayPlanDefaults(t), effectiveDone: t.done || sourceIsComplete(t) }));
    }

    /** 列出一个日期范围内（含首尾）的今日计划条目，供首页"今日/本周/历史"切换视图使用。 */
    function listTodayPlanRange(startDate, endDate) {
      return state.todayPlan
        .filter((t) => t.date >= startDate && t.date <= endDate)
        .map((t) => ({ ...withTodayPlanDefaults(t), effectiveDone: t.done || sourceIsComplete(t) }))
        .sort((a, b) => (a.date + (a.time || "99:99")).localeCompare(b.date + (b.time || "99:99")));
    }

    /**
     * 勾选/取消勾选今日计划中的一项。
     * 从"未完成"变为"完成"时，如果这一项是关联进来的，同步把源记录（学习任务的作业/一次性提醒）也标记完成。
     * 从"完成"变为"未完成"时，只改这一项本身，不回退源记录的完成状态。
     */
    /** 一项今日计划第一次变成"完成"时，顺带把它关联的源记录（作业/一次性提醒）也标记完成。 */
    function applyTodayPlanDoneSideEffects(item) {
      if (item.source === "study") {
        const a = state.studyAssignments.find((x) => x.id === item.sourceId);
        if (a) a.status = "已完成";
      } else if (item.source === "reminder") {
        const r = state.reminders.find((x) => x.id === item.sourceId);
        if (r && r.repeat === "none") r.status = "done";
      }
    }

    function toggleTodayPlanDone(id) {
      const item = findTodayPlanItem(id);
      if (!item) return null;
      const wasDone = item.done;
      item.done = !item.done;
      if (!wasDone && item.done) {
        applyTodayPlanDoneSideEffects(item);
      }
      persist();
      return { ...item, effectiveDone: item.done || sourceIsComplete(item) };
    }

    /** 累计一段已经在跑的计时到 elapsedSeconds 里，并清空 timerStartedAt（暂停/完成时都要做这一步）。 */
    function flushTodayPlanTimer(item) {
      if (item.timerStartedAt) {
        item.elapsedSeconds = (item.elapsedSeconds || 0) + Math.max(0, Math.round((Date.now() - item.timerStartedAt) / 1000));
        item.timerStartedAt = null;
      }
    }

    /** 开始（或继续）给一条今日计划计时。 */
    function startTodayPlanTimer(id) {
      const item = findTodayPlanItem(id);
      if (!item) return null;
      if (!item.timerStartedAt) {
        item.timerStartedAt = Date.now();
        persist();
      }
      return { ...item };
    }

    /** 暂停计时，把已经跑的这一段累计进 elapsedSeconds。 */
    function pauseTodayPlanTimer(id) {
      const item = findTodayPlanItem(id);
      if (!item) return null;
      flushTodayPlanTimer(item);
      persist();
      return { ...item };
    }

    /** 计时组件的"完成"按钮：先把正在跑的计时累计进去，再标记这一项完成（幂等，可重复调用）。 */
    function finishTodayPlanItem(id) {
      const item = findTodayPlanItem(id);
      if (!item) return null;
      flushTodayPlanTimer(item);
      if (!item.done) {
        item.done = true;
        applyTodayPlanDoneSideEffects(item);
      }
      persist();
      return { ...item, effectiveDone: item.done || sourceIsComplete(item) };
    }

    /** 给已完成的今日计划事项打一个满意度分（1-5星）；传 null 可以清掉。 */
    function setTodayPlanSatisfaction(id, value) {
      const item = findTodayPlanItem(id);
      if (!item) return null;
      item.satisfaction = value === null ? null : Math.min(5, Math.max(1, Math.round(Number(value))));
      persist();
      return { ...item };
    }

    function removeTodayPlanItem(id) {
      state.todayPlan = state.todayPlan.filter((t) => t.id !== id);
      persist();
    }

    /**
     * 把日期早于参考日期（默认今天）、还没完成的今日计划事项自动滚动到参考日期，
     * 而不是留在过去的日期里悄悄消失在"历史"标签下面看不见。开发计划里这条第一版
     * 明确没做，现在补上：应用每次启动（init()）时自动跑一遍。
     * - 已完成（done 或者关联的源记录已完成）的不会被滚动，还是留在原来的日期。
     * - 用 rolledFrom 记住第一次的原始日期，之后即使又隔了好几天没打开、连续被
     *   滚动多次，也只保留最早那一次的日期，方便界面上显示"延期自 X月X日"。
     */
    function rolloverUnfinishedTodayPlan(refDate = todayStr()) {
      let count = 0;
      state.todayPlan.forEach((t) => {
        if (t.date >= refDate) return;
        const done = t.done || sourceIsComplete(t);
        if (done) return;
        if (!t.rolledFrom) t.rolledFrom = t.date;
        t.date = refDate;
        count += 1;
      });
      if (count > 0) persist();
      return count;
    }

    /** 把某个学习任务的作业/考试关联进指定日期的今日计划。 */
    function linkAssignmentToToday(assignmentId, date = todayStr()) {
      const a = state.studyAssignments.find((x) => x.id === assignmentId);
      if (!a) return null;
      const already = state.todayPlan.find((t) => t.date === date && t.source === "study" && t.sourceId === assignmentId);
      if (already) return already;
      return addTodayPlanItem({ text: a.title, date, source: "study", sourceId: assignmentId });
    }

    /** 把某条提醒关联进指定日期的今日计划。 */
    function linkReminderToToday(reminderId, date = todayStr()) {
      const r = state.reminders.find((x) => x.id === reminderId);
      if (!r) return null;
      const already = state.todayPlan.find((t) => t.date === date && t.source === "reminder" && t.sourceId === reminderId);
      if (already) return already;
      return addTodayPlanItem({ text: r.title, date, source: "reminder", sourceId: reminderId });
    }

    // ---------- 学习任务：课程 / 作业考试 ----------
    function addCourse(name) {
      const c = { id: uuid(), name, createdAt: new Date().toISOString() };
      state.studyCourses.push(c);
      persist();
      return c;
    }
    function removeCourse(id) {
      state.studyCourses = state.studyCourses.filter((c) => c.id !== id);
      state.studyAssignments = state.studyAssignments.filter((a) => a.courseId !== id);
      persist();
    }
    function listCourses() {
      return [...state.studyCourses];
    }

    function addAssignment({ courseId, title, type = "作业", dueDate, status = "未开始" }) {
      const a = { id: uuid(), courseId, title, type, dueDate, status, createdAt: new Date().toISOString() };
      state.studyAssignments.push(a);
      persist();
      return a;
    }
    function updateAssignment(id, patch) {
      const a = state.studyAssignments.find((x) => x.id === id);
      if (!a) return null;
      Object.assign(a, patch);
      persist();
      return { ...a };
    }
    function removeAssignment(id) {
      state.studyAssignments = state.studyAssignments.filter((a) => a.id !== id);
      persist();
    }
    function listAssignments(courseId = null) {
      const all = state.studyAssignments;
      return courseId ? all.filter((a) => a.courseId === courseId) : [...all];
    }
    /** 跨课程按截止日期排序的未完成条目，供"最近到期"展示。 */
    function listUpcomingAssignments(limit = 5) {
      return state.studyAssignments
        .filter((a) => a.status !== "已完成")
        .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))
        .slice(0, limit);
    }

    // ---------- 学习任务：学习目标 / 打卡 / 学习记录 ----------
    function addGoal(name) {
      const g = { id: uuid(), name, createdAt: new Date().toISOString(), timerStartedAt: null, todayFocus: null };
      state.studyGoals.push(g);
      persist();
      return g;
    }
    function removeGoal(id) {
      state.studyGoals = state.studyGoals.filter((g) => g.id !== id);
      state.studyCheckins = state.studyCheckins.filter((c) => c.goalId !== id);
      persist();
    }
    function listGoals() {
      return [...state.studyGoals];
    }
    function findGoal(id) {
      return state.studyGoals.find((g) => g.id === id) || null;
    }

    /** 拿到（必要时新建）某个学习目标"今天"的专注计时统计；跨天了会自动清零重新开始统计。 */
    function ensureGoalTodayFocus(goal, date = todayStr()) {
      if (!goal.todayFocus || goal.todayFocus.date !== date) {
        goal.todayFocus = { date, elapsedSeconds: 0, pauseCount: 0, firstStartAt: null, lastStopAt: null };
      }
      return goal.todayFocus;
    }

    /** 开始（或继续）给一个学习目标计时，用于统计今天在它上面花的专注时间。 */
    function startGoalTimer(id, refDate = todayStr()) {
      const goal = findGoal(id);
      if (!goal) return null;
      const focus = ensureGoalTodayFocus(goal, refDate);
      if (!goal.timerStartedAt) {
        goal.timerStartedAt = Date.now();
        if (!focus.firstStartAt) focus.firstStartAt = goal.timerStartedAt;
        persist();
      }
      return { ...goal };
    }

    /** 暂停学习目标的计时：累计这一段用时，并记一次"暂停"（用于后面算专注度）。
     * refDate 是"这一段用时算在哪一天"，默认今天；测试里可以显式传入，不用去 mock 全局时间。 */
    function pauseGoalTimer(id, refDate = todayStr()) {
      const goal = findGoal(id);
      if (!goal) return null;
      const focus = ensureGoalTodayFocus(goal, refDate);
      if (goal.timerStartedAt) {
        const segmentSeconds = Math.max(0, Math.round((Date.now() - goal.timerStartedAt) / 1000));
        focus.elapsedSeconds += segmentSeconds;
        focus.pauseCount += 1;
        focus.lastStopAt = Date.now();
        goal.timerStartedAt = null;
        if (segmentSeconds > 0) recordStudyTime(goal.id, focus.date, segmentSeconds);
        persist();
      }
      return { ...goal };
    }

    /** 把一段学习时长累加进"每个目标每天"的学习时长日志里，供统计图表使用。 */
    function recordStudyTime(goalId, date, seconds) {
      if (seconds <= 0) return;
      const entry = state.studyTimeLog.find((e) => e.goalId === goalId && e.date === date);
      if (entry) {
        entry.seconds += seconds;
      } else {
        state.studyTimeLog.push({ id: uuid(), goalId, date, seconds });
      }
    }

    /**
     * 取最近 days 天（含 refDate 当天）的学习时长统计，按天排列（从早到晚），
     * 每天给出总时长和按目标拆分的明细，供"学习时长可视化统计图表"用手绘柱状图展示。
     */
    function listStudyTimeSeries(days = 7, refDate = todayStr()) {
      const result = [];
      for (let i = days - 1; i >= 0; i -= 1) {
        const date = addDays(refDate, -i);
        const entries = state.studyTimeLog.filter((e) => e.date === date && e.seconds > 0);
        const totalSeconds = entries.reduce((sum, e) => sum + e.seconds, 0);
        const byGoal = entries.map((e) => {
          const g = findGoal(e.goalId);
          return { goalId: e.goalId, name: g ? g.name : "（已删除的目标）", seconds: e.seconds };
        });
        result.push({ date, totalSeconds, byGoal });
      }
      return result;
    }

    /** 汇总"今天"所有学习目标的计时数据，供学习报告使用；不管计时器是不是还在跑，都会把正在跑的这一段也算进去。 */
    function listGoalsWithTodayFocus(date = todayStr()) {
      return state.studyGoals.map((g) => {
        const focus = g.todayFocus && g.todayFocus.date === date ? g.todayFocus : { date, elapsedSeconds: 0, pauseCount: 0, firstStartAt: null, lastStopAt: null };
        const running = g.timerStartedAt ? Math.max(0, Math.round((Date.now() - g.timerStartedAt) / 1000)) : 0;
        return {
          id: g.id, name: g.name,
          elapsedSeconds: focus.elapsedSeconds + running,
          pauseCount: focus.pauseCount,
          firstStartAt: focus.firstStartAt,
          lastStopAt: g.timerStartedAt ? Date.now() : focus.lastStopAt,
          running: !!g.timerStartedAt,
        };
      });
    }
    function checkinGoal(goalId, date = todayStr()) {
      const exists = state.studyCheckins.find((c) => c.goalId === goalId && c.date === date);
      if (exists) return exists;
      const c = { id: uuid(), goalId, date };
      state.studyCheckins.push(c);
      persist();
      return c;
    }
    function isCheckedIn(goalId, date = todayStr()) {
      return state.studyCheckins.some((c) => c.goalId === goalId && c.date === date);
    }
    function countCheckins(goalId) {
      return state.studyCheckins.filter((c) => c.goalId === goalId).length;
    }
    function setDailyLog(date, text) {
      const existing = state.studyDailyLogs.find((l) => l.date === date);
      if (existing) {
        existing.text = text;
      } else {
        state.studyDailyLogs.push({ id: uuid(), date, text });
      }
      persist();
    }
    function getDailyLog(date = todayStr()) {
      return state.studyDailyLogs.find((l) => l.date === date)?.text ?? "";
    }

    // ---------- 提醒事项 ----------
    function addReminder({ title, date, repeat = "none", note = "" }) {
      const r = { id: uuid(), title, date, repeat, note, status: "pending", createdAt: new Date().toISOString() };
      state.reminders.push(r);
      persist();
      return r;
    }
    function updateReminder(id, patch) {
      const r = state.reminders.find((x) => x.id === id);
      if (!r) return null;
      Object.assign(r, patch);
      persist();
      return { ...r };
    }
    function removeReminder(id) {
      state.reminders = state.reminders.filter((r) => r.id !== id);
      persist();
    }
    function markReminderDone(id) {
      const r = state.reminders.find((x) => x.id === id);
      if (!r || r.repeat !== "none") return null;
      r.status = "done";
      persist();
      return { ...r };
    }
    function listReminders() {
      return [...state.reminders];
    }
    /** 提醒的展示用视图：附上按参考日期算出的下一次发生日期。 */
    function listRemindersWithNextDate(refDate = todayStr()) {
      return state.reminders.map((r) => ({
        ...r,
        nextDate: computeNextOccurrence(r.date, r.repeat, refDate),
      }));
    }

    // ---------- 饮食计划 ----------
    /** recipeId 可选：某餐是从菜谱库里选的，就记下是哪个菜谱，方便"自动生成购物清单"用。
     * 手动填写文字（不传 recipeId，或显式传 null）会清掉原来的菜谱关联——因为用户已经不再是
     * "选了这个菜谱"，而是自己重新填了内容，两者不应该再挂钩。 */
    function setMealEntry(date, slot, text, recipeId = null) {
      const existing = state.mealPlanEntries.find((e) => e.date === date && e.slot === slot);
      if (existing) {
        existing.text = text;
        existing.recipeId = recipeId;
      } else {
        state.mealPlanEntries.push({ id: uuid(), date, slot, text, recipeId });
      }
      persist();
    }
    function getMealEntry(date, slot) {
      return state.mealPlanEntries.find((e) => e.date === date && e.slot === slot)?.text ?? "";
    }
    /** 拿到某一餐完整的记录（文字 + 关联的菜谱id），给需要知道"这餐是不是选了菜谱"的界面用。 */
    function getMealEntryRecord(date, slot) {
      const e = state.mealPlanEntries.find((x) => x.date === date && x.slot === slot);
      return e ? { text: e.text, recipeId: e.recipeId || null } : { text: "", recipeId: null };
    }
    function listMealEntriesForWeek(mondayStr) {
      const dates = new Set([0, 1, 2, 3, 4, 5, 6].map((i) => addDays(mondayStr, i)));
      return state.mealPlanEntries.filter((e) => dates.has(e.date));
    }
    /** 把从 fromMonday 开始那一周的三餐安排，整体复制到 toMonday 开始的那一周（按相同偏移量）。 */
    function copyWeek(fromMonday, toMonday) {
      const offsetDays = Math.round(
        (Date.parse(toMonday) - Date.parse(fromMonday)) / (24 * 60 * 60 * 1000)
      );
      const entries = listMealEntriesForWeek(fromMonday);
      entries.forEach((e) => {
        const targetDate = addDays(e.date, offsetDays);
        setMealEntry(targetDate, e.slot, e.text, e.recipeId || null);
      });
      return entries.length;
    }

    // ---------- 常用菜谱库 ----------
    function addRecipe({ name, ingredients = [] }) {
      const r = {
        id: uuid(),
        name,
        ingredients: ingredients.map((i) => ({ name: i.name, quantity: i.quantity == null ? null : Number(i.quantity), unit: i.unit || "" })),
        createdAt: new Date().toISOString(),
      };
      state.recipes.push(r);
      persist();
      return r;
    }
    function updateRecipe(id, patch) {
      const r = state.recipes.find((x) => x.id === id);
      if (!r) return null;
      if (patch.name !== undefined) r.name = patch.name;
      if (patch.ingredients !== undefined) {
        r.ingredients = patch.ingredients.map((i) => ({ name: i.name, quantity: i.quantity == null ? null : Number(i.quantity), unit: i.unit || "" }));
      }
      persist();
      return { ...r };
    }
    /** 删除菜谱：已经排进三餐计划里的那些格子不会跟着消失，只是不再指向这个（已经不存在的）菜谱。 */
    function removeRecipe(id) {
      state.recipes = state.recipes.filter((r) => r.id !== id);
      state.mealPlanEntries.forEach((e) => { if (e.recipeId === id) e.recipeId = null; });
      persist();
    }
    function listRecipes() {
      return [...state.recipes];
    }
    function findRecipe(id) {
      return state.recipes.find((r) => r.id === id) || null;
    }
    /** 把某一餐直接设置成菜谱库里的某个菜谱（文字用菜谱名字，同时记下关联）。 */
    function setMealEntryFromRecipe(date, slot, recipeId) {
      const recipe = findRecipe(recipeId);
      if (!recipe) return null;
      setMealEntry(date, slot, recipe.name, recipe.id);
      return getMealEntryRecord(date, slot);
    }

    /**
     * 根据某一周三餐计划里选用的菜谱，自动汇总食材、生成购物清单条目。
     * - 只处理关联了菜谱的格子（手动填写文字的格子没有结构化食材，没法自动生成）。
     * - 同名同单位的食材会自动合并数量；只要有一处数量不确定（没填数量），合并结果就不再显示
     *   具体数量，只保留"需要买"这件事本身，不会因为半个未知数就把已知的量也搞错。
     * - 已经在购物清单里的同名同单位条目不会重复添加，避免每点一次"生成"清单就翻倍。
     * 返回这次实际新增了几条，方便界面提示。
     */
    function generateShoppingListFromMealPlan(mondayStr) {
      const entries = listMealEntriesForWeek(mondayStr).filter((e) => e.recipeId);
      const aggregated = new Map();
      entries.forEach((e) => {
        const recipe = findRecipe(e.recipeId);
        if (!recipe) return;
        recipe.ingredients.forEach((ing) => {
          const name = (ing.name || "").trim();
          if (!name) return;
          const unit = ing.unit || "";
          const key = `${name}|${unit}`;
          if (aggregated.has(key)) {
            const cur = aggregated.get(key);
            cur.quantity = cur.quantity != null && ing.quantity != null ? cur.quantity + ing.quantity : null;
          } else {
            aggregated.set(key, { name, unit, quantity: ing.quantity == null ? null : Number(ing.quantity) });
          }
        });
      });

      let addedCount = 0;
      aggregated.forEach((ing) => {
        const already = state.shoppingListItems.some(
          (s) => !s.linkedItemId && s.name.trim() === ing.name && (s.unit || "") === ing.unit
        );
        if (already) return;
        state.shoppingListItems.push({
          id: uuid(), name: ing.name, linkedItemId: null,
          quantity: ing.quantity, unit: ing.unit, fromRecipe: true,
          createdAt: new Date().toISOString(),
        });
        addedCount += 1;
      });
      if (addedCount > 0) persist();
      return addedCount;
    }

    // ---------- 生活用品库存 / 购物清单 ----------
    function addInventoryItem({ name, quantity = 0, unit = "", lowThreshold = 0, expiryDate = null }) {
      const item = { id: uuid(), name, quantity, unit, lowThreshold, expiryDate, createdAt: new Date().toISOString() };
      state.inventoryItems.push(item);
      persist();
      syncShoppingListFromLowStock();
      return item;
    }
    function updateInventoryItem(id, patch) {
      const item = state.inventoryItems.find((x) => x.id === id);
      if (!item) return null;
      Object.assign(item, patch);
      persist();
      syncShoppingListFromLowStock();
      return { ...item };
    }
    function removeInventoryItem(id) {
      state.inventoryItems = state.inventoryItems.filter((x) => x.id !== id);
      state.shoppingListItems = state.shoppingListItems.filter((s) => s.linkedItemId !== id);
      persist();
    }
    function listInventoryItems() {
      return [...state.inventoryItems];
    }
    function isLowStock(item) {
      return item.quantity <= item.lowThreshold;
    }

    function addShoppingItem({ name, linkedItemId = null }) {
      const s = { id: uuid(), name, linkedItemId, createdAt: new Date().toISOString() };
      state.shoppingListItems.push(s);
      persist();
      return s;
    }
    function removeShoppingItem(id) {
      state.shoppingListItems = state.shoppingListItems.filter((s) => s.id !== id);
      persist();
    }
    function listShoppingItems() {
      return [...state.shoppingListItems];
    }
    /** 确保每个低库存物品在购物清单里都有对应条目（没有才补，不会重复添加）。 */
    function syncShoppingListFromLowStock() {
      const lowStockItems = state.inventoryItems.filter(isLowStock);
      lowStockItems.forEach((item) => {
        const alreadyListed = state.shoppingListItems.some((s) => s.linkedItemId === item.id);
        if (!alreadyListed) {
          state.shoppingListItems.push({ id: uuid(), name: item.name, linkedItemId: item.id, createdAt: new Date().toISOString() });
        }
      });
      persist();
    }

    /**
     * 购物清单勾选"买到了"：自动把买到的数量加回对应的库存物品，然后把这一条从购物清单里移除
     * ——不再需要买完东西之后又手动去库存管理页把数量改回去。
     * - 优先用购物清单条目自带的 linkedItemId（低库存自动生成的条目都有）找库存物品；
     *   没有的话（比如菜谱自动生成购物清单时是按食材名字生成的，没有关联具体库存物品）
     *   退而求其次按名字精确匹配一个现有库存物品。
     * - 两种都找不到、但确实买了东西：直接新建一个库存物品（数量就是这次买的量，
     *   阈值先给0，用户自己后面可以再调），而不是让这份数据凭空消失。
     * - purchasedQuantity 不传的话，优先用购物清单条目自己带的建议数量（比如菜谱汇总出来的食材用量），
     *   再没有就默认按1份算。
     */
    function resolveShoppingItem(id, purchasedQuantity) {
      const s = state.shoppingListItems.find((x) => x.id === id);
      if (!s) return null;
      const qty = purchasedQuantity != null ? Number(purchasedQuantity) : (s.quantity != null ? Number(s.quantity) : 1);
      const safeQty = Number.isFinite(qty) ? qty : 0;

      let item = s.linkedItemId ? state.inventoryItems.find((x) => x.id === s.linkedItemId) : null;
      if (!item) {
        item = state.inventoryItems.find((x) => x.name.trim() === s.name.trim()) || null;
      }
      if (item) {
        item.quantity = Math.round((item.quantity + safeQty) * 100) / 100;
      } else if (safeQty > 0) {
        item = addInventoryItem({ name: s.name, quantity: safeQty, unit: s.unit || "", lowThreshold: 0 });
      }
      state.shoppingListItems = state.shoppingListItems.filter((x) => x.id !== id);
      persist();
      return item ? { ...item } : null;
    }

    /**
     * 记一次"消耗"（用掉了多少），和"编辑库存数量"是两回事：编辑数量是纠正/校准，
     * 记消耗是真实发生的一次用量，会累加进 inventoryConsumptionLog，供"消耗趋势"统计。
     * 消耗后库存不会变成负数；如果因此变成低库存，会照常自动补进购物清单。
     */
    function recordConsumption(itemId, amount, refDate = todayStr()) {
      const item = state.inventoryItems.find((x) => x.id === itemId);
      if (!item) return null;
      const amt = Math.max(0, Number(amount) || 0);
      if (amt > 0) {
        item.quantity = Math.max(0, Math.round((item.quantity - amt) * 100) / 100);
        state.inventoryConsumptionLog.push({ id: uuid(), itemId, name: item.name, unit: item.unit, amount: amt, date: refDate });
        persist();
        syncShoppingListFromLowStock();
      }
      return { ...item };
    }

    /**
     * 最近 days 天里消耗最多的物品排行（用于"消耗趋势"），按累计消耗量从高到低排序。
     * name 用的是记消耗那一刻的物品名字快照，就算后来这个库存物品被删除了，排行榜里
     * 还是能看到历史上确实消耗过它，不会因为物品被删就把这段历史也一起丢掉。
     */
    function listTopConsumedItems(days = 30, refDate = todayStr(), limit = 5) {
      const cutoff = addDays(refDate, -(days - 1));
      const totals = new Map();
      state.inventoryConsumptionLog.forEach((log) => {
        if (log.date < cutoff || log.date > refDate) return;
        const cur = totals.get(log.itemId) || { itemId: log.itemId, name: log.name, unit: log.unit || "", totalAmount: 0 };
        cur.totalAmount = Math.round((cur.totalAmount + log.amount) * 100) / 100;
        totals.set(log.itemId, cur);
      });
      return [...totals.values()].sort((a, b) => b.totalAmount - a.totalAmount).slice(0, limit);
    }

    // ---------- 个人记账 ----------
    const CURRENCIES = ["CNY", "EUR", "USD", "JPY", "GBP", "HKD"];

    /** 汇率表（1 单位该货币 = 多少人民币），供界面展示和手动修改。 */
    function getExchangeRates() {
      return { ...state.financeExchangeRates };
    }
    function getExchangeRatesUpdatedAt() {
      return state.financeExchangeRatesUpdatedAt;
    }
    /** 修改一种货币对人民币的汇率（不能改人民币自己的 1:1）。 */
    function setExchangeRate(currency, rate) {
      if (currency === "CNY") return getExchangeRates();
      const n = Number(rate);
      if (!Number.isFinite(n) || n <= 0) return getExchangeRates();
      state.financeExchangeRates = { ...state.financeExchangeRates, [currency]: n };
      persist();
      return getExchangeRates();
    }
    /**
     * 一次性批量写入多种货币的汇率（联网刷新回来的一整批结果用这个，比逐个调用
     * setExchangeRate 只 persist 一次，效率更好），并记下这次刷新的时间。
     * 非法/非正数的值会被跳过，不会把汇率表污染成 NaN 或负数；一个都没成功写入的话
     * 不更新时间戳（避免"刷新失败但显示刷新成功"的误导）。
     */
    function setExchangeRates(ratesByCurrency) {
      let changed = 0;
      const next = { ...state.financeExchangeRates };
      Object.keys(ratesByCurrency || {}).forEach((currency) => {
        if (currency === "CNY" || !CURRENCIES.includes(currency)) return;
        const n = Number(ratesByCurrency[currency]);
        if (!Number.isFinite(n) || n <= 0) return;
        next[currency] = n;
        changed += 1;
      });
      if (changed === 0) return { updated: 0, rates: getExchangeRates() };
      state.financeExchangeRates = next;
      state.financeExchangeRatesUpdatedAt = new Date().toISOString();
      persist();
      return { updated: changed, rates: getExchangeRates() };
    }
    /** 按当前汇率表把一笔金额换算成人民币等值（用于汇总统计）。 */
    function convertToCNY(amount, currency) {
      const rate = state.financeExchangeRates[currency] ?? 1;
      return Math.round(amount * rate * 100) / 100;
    }

    /** accountId 不传的话，默认记到第一个账户名下（多账户功能加入前只有一个隐含账户，
     * 加入后至少会有 ensureDefaultAccount() 建的"默认账户"，不会出现"记了账却不知道是哪个账户"的情况）。 */
    function addTransaction({ amount, currency = "CNY", type, category, date = todayStr(), note = "", accountId = null }) {
      const amountCNY = convertToCNY(amount, currency);
      const resolvedAccountId = accountId || (state.financeAccounts[0] ? state.financeAccounts[0].id : null);
      const t = { id: uuid(), amount, currency, amountCNY, type, category, date, note, accountId: resolvedAccountId, createdAt: new Date().toISOString() };
      state.financeTransactions.push(t);
      persist();
      return t;
    }
    /** 修改一笔已有记录（金额/币种/分类/日期/备注/账户等），不需要删除重新录入。金额或币种变了就重新按当前汇率换算成人民币等值。 */
    function updateTransaction(id, patch) {
      const t = state.financeTransactions.find((x) => x.id === id);
      if (!t) return null;
      Object.assign(t, patch);
      if (!CURRENCIES.includes(t.currency)) t.currency = "CNY";
      t.amountCNY = convertToCNY(t.amount, t.currency);
      persist();
      return { ...t };
    }
    function removeTransaction(id) {
      state.financeTransactions = state.financeTransactions.filter((t) => t.id !== id);
      persist();
    }
    function listTransactions({ month = null, accountId = null } = {}) {
      let all = state.financeTransactions.map((t) => ({ currency: "CNY", amountCNY: t.amount, accountId: null, ...t }));
      if (month) all = all.filter((t) => t.date.startsWith(month)); // month: 'YYYY-MM'
      if (accountId) all = all.filter((t) => t.accountId === accountId);
      return all;
    }
    function addCategory(name) {
      if (!state.financeCategories.includes(name)) {
        state.financeCategories.push(name);
        persist();
      }
    }
    function removeCategory(name) {
      state.financeCategories = state.financeCategories.filter((c) => c !== name);
      persist();
    }
    function listCategories() {
      return [...state.financeCategories];
    }

    // ---------- 个人记账：预算超支提醒 ----------
    /** 设置（或清除，传0/负数/不传）某个分类的月度预算上限；没设置预算的分类不参与"超支提醒"统计。 */
    function setBudget(category, monthlyLimit) {
      const n = Number(monthlyLimit);
      if (!Number.isFinite(n) || n <= 0) {
        delete state.financeBudgets[category];
      } else {
        state.financeBudgets[category] = n;
      }
      persist();
      return { ...state.financeBudgets };
    }
    function removeBudget(category) {
      delete state.financeBudgets[category];
      persist();
    }
    function getBudgets() {
      return { ...state.financeBudgets };
    }
    /** 每个设了预算的分类，这个月已经花了多少、还剩多少、有没有超支——用于首页/记账页的"预算超支提醒"。 */
    function getBudgetStatus(month = todayStr().slice(0, 7)) {
      const txs = listTransactions({ month }).filter((t) => t.type === "expense");
      const spentByCategory = new Map();
      txs.forEach((t) => spentByCategory.set(t.category, (spentByCategory.get(t.category) || 0) + t.amountCNY));
      return Object.entries(state.financeBudgets)
        .map(([category, budget]) => {
          const spent = Math.round((spentByCategory.get(category) || 0) * 100) / 100;
          return {
            category,
            budget,
            spent,
            remaining: Math.round((budget - spent) * 100) / 100,
            percent: budget > 0 ? Math.round((spent / budget) * 1000) / 10 : 0,
            overspent: spent > budget,
          };
        })
        .sort((a, b) => b.percent - a.percent);
    }

    // ---------- 个人记账：收支图表（按月汇总） ----------
    /** 最近 months 个月（含 refMonth 当月）每个月的收入/支出总额，供"收支图表"用手绘柱状图展示。 */
    function listMonthlyTotals(months = 6, refMonth = todayStr().slice(0, 7)) {
      const result = [];
      for (let i = months - 1; i >= 0; i -= 1) {
        const month = shiftMonth(refMonth, -i);
        const txs = listTransactions({ month });
        const income = Math.round(txs.filter((t) => t.type === "income").reduce((s, t) => s + t.amountCNY, 0) * 100) / 100;
        const expense = Math.round(txs.filter((t) => t.type === "expense").reduce((s, t) => s + t.amountCNY, 0) * 100) / 100;
        result.push({ month, income, expense });
      }
      return result;
    }

    // ---------- 个人记账：多账户 ----------
    /** 多账户功能加入之前，所有记账其实都只记在一个隐含账户里；这里保证至少存在一个账户，
     * 并把没有账户归属的老记录（accountId 是 null/undefined）都归到这个新建的"默认账户"名下，
     * 只在完全没有账户的时候跑一次，不会覆盖用户后续自己建的账户结构。 */
    function ensureDefaultAccount() {
      if (state.financeAccounts.length > 0) return;
      const acc = { id: uuid(), name: "默认账户", initialBalance: 0, createdAt: new Date().toISOString() };
      state.financeAccounts.push(acc);
      state.financeTransactions.forEach((t) => { if (!t.accountId) t.accountId = acc.id; });
      persist();
    }
    function addAccount({ name, initialBalance = 0 }) {
      const a = { id: uuid(), name, initialBalance: Number(initialBalance) || 0, createdAt: new Date().toISOString() };
      state.financeAccounts.push(a);
      persist();
      return a;
    }
    function updateAccount(id, patch) {
      const a = state.financeAccounts.find((x) => x.id === id);
      if (!a) return null;
      Object.assign(a, patch);
      persist();
      return { ...a };
    }
    /** 删除账户不会删掉这个账户名下的记账记录，只是把它们的账户归属清空（变成"未分配账户"），
     * 数据本身不会丢。 */
    function removeAccount(id) {
      state.financeAccounts = state.financeAccounts.filter((a) => a.id !== id);
      state.financeTransactions.forEach((t) => { if (t.accountId === id) t.accountId = null; });
      persist();
    }
    function listAccounts() {
      return [...state.financeAccounts];
    }
    /** 账户余额 = 期初余额 + 这个账户名下所有收入（人民币等值）- 所有支出（人民币等值）。 */
    function getAccountBalance(accountId) {
      const account = state.financeAccounts.find((a) => a.id === accountId);
      if (!account) return null;
      const txs = listTransactions({ accountId });
      const income = txs.filter((t) => t.type === "income").reduce((s, t) => s + t.amountCNY, 0);
      const expense = txs.filter((t) => t.type === "expense").reduce((s, t) => s + t.amountCNY, 0);
      return Math.round((account.initialBalance + income - expense) * 100) / 100;
    }
    /** 每个账户连同它当前余额一起列出来，供账户切换器/账户列表界面直接用。 */
    function listAccountsWithBalance() {
      return state.financeAccounts.map((a) => ({ ...a, balance: getAccountBalance(a.id) }));
    }

    // ---------- 游戏娱乐 ----------
    /** rating（1-5星，没评分是null）和 review（文字评价）是后加的可选字段，老游戏记录没有这两个字段，
     * 界面上按"还没有评分"处理，不需要迁移。 */
    function addGame({ name, status = "想玩", note = "" }) {
      const g = { id: uuid(), name, status, note, rating: null, review: "", createdAt: new Date().toISOString() };
      state.games.push(g);
      persist();
      return g;
    }
    /** updateGame 是通用的字段patch，评分/评论也是通过它来改的（patch: { rating, review }），
     * 不需要单独的 setGameRating 之类的函数。rating 会被夹到 1-5 之间，传 null 可以清掉。 */
    function updateGame(id, patch) {
      const g = state.games.find((x) => x.id === id);
      if (!g) return null;
      Object.assign(g, patch);
      if (patch.rating !== undefined) {
        g.rating = patch.rating === null ? null : Math.min(5, Math.max(1, Math.round(Number(patch.rating))));
      }
      persist();
      return { ...g };
    }
    function removeGame(id) {
      state.games = state.games.filter((g) => g.id !== id);
      state.gameSessions = state.gameSessions.filter((s) => s.gameId !== id);
      persist();
    }
    function listGames(status = null) {
      const all = state.games;
      return status ? all.filter((g) => g.status === status) : [...all];
    }
    function addPlaySession({ gameId, date = todayStr(), minutes }) {
      const s = { id: uuid(), gameId, date, minutes, createdAt: new Date().toISOString() };
      state.gameSessions.push(s);
      persist();
      return s;
    }
    function listSessions(gameId) {
      return state.gameSessions.filter((s) => s.gameId === gameId);
    }
    function totalMinutesForGame(gameId) {
      return state.gameSessions
        .filter((s) => s.gameId === gameId)
        .reduce((sum, s) => sum + s.minutes, 0);
    }

    /**
     * 最近 days 天（含 refDate 当天）每天的总游玩时长，按天排列（从早到晚），
     * 每天再按游戏拆分明细，供"游玩数据统计图表"用手绘柱状图展示。
     */
    function listGamePlaytimeSeries(days = 7, refDate = todayStr()) {
      const result = [];
      for (let i = days - 1; i >= 0; i -= 1) {
        const date = addDays(refDate, -i);
        const sessions = state.gameSessions.filter((s) => s.date === date);
        const totalMinutes = sessions.reduce((sum, s) => sum + s.minutes, 0);
        const byGameMap = new Map();
        sessions.forEach((s) => byGameMap.set(s.gameId, (byGameMap.get(s.gameId) || 0) + s.minutes));
        const byGame = [...byGameMap.entries()].map(([gameId, minutes]) => {
          const g = findGame(gameId);
          return { gameId, name: g ? g.name : "（已删除的游戏）", minutes };
        });
        result.push({ date, totalMinutes, byGame });
      }
      return result;
    }

    /** 最近 days 天里游玩时长最多的游戏排行。注意：删除游戏会级联删除它的游玩记录（既有行为，
     * 和"库存消耗"那种独立日志不一样），所以这里天然不会出现"游戏已删除但排行榜还有它"的情况。 */
    function listTopPlayedGames(days = 30, refDate = todayStr(), limit = 5) {
      const cutoff = addDays(refDate, -(days - 1));
      const totals = new Map();
      state.gameSessions.forEach((s) => {
        if (s.date < cutoff || s.date > refDate) return;
        const g = findGame(s.gameId);
        const name = g ? g.name : "（已删除的游戏）";
        const cur = totals.get(s.gameId) || { gameId: s.gameId, name, totalMinutes: 0 };
        cur.totalMinutes += s.minutes;
        totals.set(s.gameId, cur);
      });
      return [...totals.values()].sort((a, b) => b.totalMinutes - a.totalMinutes).slice(0, limit);
    }
    function findGame(id) {
      return state.games.find((g) => g.id === id) || null;
    }

    // ---------- 读书笔记 ----------
    function addBook({ title, author, status, rating }) {
      const book = {
        id: uuid(),
        title,
        author: author || "",
        status: BOOK_STATUSES.includes(status) ? status : "想读",
        rating: rating ? Number(rating) : null,
        createdAt: new Date().toISOString(),
      };
      state.books.push(book);
      persist();
      return book;
    }
    function updateBook(id, patch) {
      const book = state.books.find((b) => b.id === id);
      if (!book) return null;
      const next = { ...patch };
      if ("status" in next && !BOOK_STATUSES.includes(next.status)) delete next.status;
      if ("rating" in next) next.rating = next.rating ? Math.min(5, Math.max(1, Number(next.rating))) : null;
      // 状态改成"读完"且之前没记录过完成日期时，自动盖个今天的时间戳，用于读完趋势统计；
      // 后续再手动改成别的状态不会清掉这个日期（保留"曾经读完过"的历史）。
      if (next.status === "读完" && !book.finishedAt && !next.finishedAt) next.finishedAt = new Date().toISOString().slice(0, 10);
      Object.assign(book, next);
      persist();
      return book;
    }
    function removeBook(id) {
      state.books = state.books.filter((b) => b.id !== id);
      state.bookNotes = state.bookNotes.filter((n) => n.bookId !== id);
      persist();
    }
    function listBooks(status) {
      const all = [...state.books].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      return status && status !== "全部" ? all.filter((b) => b.status === status) : all;
    }
    function findBook(id) {
      return state.books.find((b) => b.id === id) || null;
    }
    function addBookNote(bookId, text, page) {
      const note = {
        id: uuid(),
        bookId,
        text,
        page: page || null,
        createdAt: new Date().toISOString(),
      };
      state.bookNotes.push(note);
      persist();
      return note;
    }
    function removeBookNote(id) {
      state.bookNotes = state.bookNotes.filter((n) => n.id !== id);
      persist();
    }
    function listBookNotes(bookId) {
      // 用数组本身的插入顺序倒转来实现"最新在前"，不用 createdAt 时间戳排序——
      // 两条笔记如果在同一毫秒内连续添加（比如自动化测试里），时间戳会完全相同，
      // 排序结果就不可靠了；数组的插入顺序本身就是绝对可靠的先后关系。
      return state.bookNotes.filter((n) => n.bookId === bookId).reverse();
    }
    function countBookNotes(bookId) {
      return state.bookNotes.filter((n) => n.bookId === bookId).length;
    }
    /** 最近12个月，每月读完的书数量——首页/读书笔记页的小柱状图用。 */
    function listBooksFinishedSeries(months = 6, refDate = todayStr()) {
      const anchor = new Date(refDate + "T00:00:00");
      const buckets = [];
      for (let i = months - 1; i >= 0; i--) {
        const d = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1);
        buckets.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, count: 0 });
      }
      const map = new Map(buckets.map((b) => [b.month, b]));
      state.books.forEach((b) => {
        if (b.status !== "读完" || !b.finishedAt) return;
        const month = String(b.finishedAt).slice(0, 7);
        const bucket = map.get(month);
        if (bucket) bucket.count += 1;
      });
      return buckets;
    }

    // ---------- 课堂笔记 ----------
    /** 新建一条课堂笔记（录音开始时调用，或者上传一份已有录音文件时调用）。
     * sourceLang 是讲课语言，targetLangs 是要互译成的语言列表，courseId 是所属课程
     * （不传/传 null 就是"未分类"，之后可以用 setClassNoteCourseId 随时改）。
     * sourceType 区分这条笔记的音频是"现场录音"还是"上传的已有录音文件"——上传的笔记
     * 没有"实时识别"这一步，直接走云端语音转文字服务把结果写进 transcriptSegments。 */
    function addClassNote({ title, sourceLang = "fr", targetLangs = [], courseId = null, sourceType = "recorded" } = {}) {
      const note = {
        id: uuid(),
        title: title || "",
        sourceLang,
        targetLangs: Array.isArray(targetLangs) ? targetLangs.filter((l) => l !== sourceLang) : [],
        courseId: courseId || null,
        sourceType: sourceType === "uploaded" ? "uploaded" : "recorded",
        // 转录分段：[{ start, end, text }]，start/end 是相对录音开始的秒数。
        transcriptSegments: [],
        // 翻译结果按目标语言代码分开存：{ en: [{start,end,text}], zh: [...] }。
        // 没有生成过翻译的语言不会出现在这个对象里。
        translations: {},
        // AI 整理出的结构化笔记（Markdown 文本，语言等于 sourceLang），没生成过是空字符串。
        notesMarkdown: "",
        // 笔记正文翻译成其它语言的结果，按语言代码分开存：{ en: "markdown...", zh: "..." }；
        // 没翻译过的语言不会出现在这个对象里，跟 translations（转录的翻译）是同一个模式。
        notesTranslations: {},
        // 闪卡：[{question, answer}]，根据 notesMarkdown 生成，没生成过是空数组。
        flashcards: [],
        // 测验：[{question, options:[...], correctIndex, selectedIndex}]，selectedIndex 是
        // 学生选的答案下标，还没作答时是 null；没生成过是空数组。
        quiz: [],
        // 针对这条笔记的问答记录：[{role:"user"|"assistant", text}]，没问过是空数组。
        qaMessages: [],
        // 录音时长（秒）和音频在 IndexedDB 里的引用 key；没有录完/还没存音频时为 null。
        audioDurationSeconds: 0,
        audioKey: null,
        // 上传的课件/拍照材料：[{id, kind:"image"|"pptx", name, addedAt, storageKey?, extractedText?}]。
        // 图片（kind:"image"）体积大，正文不存在这里——真正的 Blob 存在 IndexedDB，
        // storageKey 是指向 IndexedDB 里那条记录的 key（跟 audioKey 是同一种"指针"模式）。
        // PPT（kind:"pptx"）文件本身不保留，只保留客户端解析出来的 extractedText 纯文本。
        // 注意：这是后加的字段，不进 isValidDataShape 的 required 列表。
        materials: [],
        // AI 根据笔记正文（和材料）生成的思维导图，结构是 {title, children:[...]} 的嵌套树，
        // 没生成过是 null。同样是后加字段，不进 isValidDataShape 的 required。
        mindMap: null,
        // "整体重新识别"：对着已经存好的录音音频，调用云端语音转文字服务重新识别一遍
        // （用来对付实时识别漏内容的问题），跟 transcriptSegments（实时识别/上传笔记的
        // 主转录）是两份独立的数据，界面上可以切换对比。没生成过是 null。
        // 结构：{ provider: "google"|"azure", segments: [{text}], translations: {lang:[{text}]}, generatedAt }。
        // 同样是后加字段，不进 isValidDataShape 的 required。
        retranscript: null,
        status: "recording", // recording | recorded | notes_ready
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.classNotes.push(note);
      persist();
      return note;
    }

    function findClassNote(id) {
      return state.classNotes.find((n) => n.id === id) || null;
    }

    function touchClassNote(note) {
      note.updatedAt = new Date().toISOString();
    }

    /** 追加一段转录文字（实时转录过程中，每出一个"最终结果"就调用一次）。 */
    function appendClassNoteTranscript(id, segment) {
      const note = findClassNote(id);
      if (!note) return null;
      const text = (segment && segment.text || "").trim();
      if (!text) return note;
      note.transcriptSegments.push({
        start: Number(segment.start) || 0,
        end: Number(segment.end) || 0,
        text,
      });
      touchClassNote(note);
      persist();
      return note;
    }

    /** 录音结束：标记状态、记录总时长和音频引用。 */
    function finishClassNoteRecording(id, { durationSeconds = 0, audioKey = null } = {}) {
      const note = findClassNote(id);
      if (!note) return null;
      note.status = "recorded";
      note.audioDurationSeconds = Number(durationSeconds) || 0;
      note.audioKey = audioKey;
      touchClassNote(note);
      persist();
      return note;
    }

    /** 保存某个目标语言的翻译结果（整段替换，用户手动点"重新翻译全部"时用）。 */
    function setClassNoteTranslation(id, lang, segments) {
      const note = findClassNote(id);
      if (!note) return null;
      note.translations = { ...note.translations, [lang]: Array.isArray(segments) ? segments : [] };
      touchClassNote(note);
      persist();
      return note;
    }

    /**
     * 追加一批翻译结果到某个目标语言已有的翻译后面（不是整段替换）。
     * 录音过程中的自动翻译每隔几秒只翻译"新增的那一小段转录"，如果还是用
     * setClassNoteTranslation 整段替换，每次都要把已经翻译过的部分也重新传一遍、
     * 重新存一遍，3小时的课录到后面转录越来越长，会越来越慢；用追加的话每次只处理
     * 新增的一小段，跟录音时长无关，性能不会随时间变差。
     */
    function appendClassNoteTranslation(id, lang, segments) {
      const note = findClassNote(id);
      if (!note) return null;
      const toAppend = Array.isArray(segments) ? segments : [];
      if (toAppend.length === 0) return note;
      const existing = note.translations[lang] || [];
      note.translations = { ...note.translations, [lang]: [...existing, ...toAppend] };
      touchClassNote(note);
      persist();
      return note;
    }

    /** 保存 AI 整理出的结构化笔记正文。 */
    function setClassNoteMarkdown(id, markdown) {
      const note = findClassNote(id);
      if (!note) return null;
      note.notesMarkdown = typeof markdown === "string" ? markdown : "";
      note.status = "notes_ready";
      touchClassNote(note);
      persist();
      return note;
    }

    /**
     * 保存笔记正文翻译成某个目标语言的结果（整段替换，笔记正文本来就不长，不需要像
     * appendClassNoteTranslation 那样做"只追加新内容"的性能优化）。
     */
    function setClassNoteNotesTranslation(id, lang, markdown) {
      const note = findClassNote(id);
      if (!note) return null;
      note.notesTranslations = { ...(note.notesTranslations || {}), [lang]: typeof markdown === "string" ? markdown : "" };
      touchClassNote(note);
      persist();
      return note;
    }

    /** 保存 AI 根据笔记正文生成的闪卡（整段替换，重新生成会覆盖上一批）。 */
    function setClassNoteFlashcards(id, flashcards) {
      const note = findClassNote(id);
      if (!note) return null;
      note.flashcards = Array.isArray(flashcards) ? flashcards : [];
      touchClassNote(note);
      persist();
      return note;
    }

    /** 保存 AI 根据笔记正文生成的测验题（整段替换）；每题附带的 selectedIndex 统一
     * 重置为 null（还没作答），避免重新生成一批新题目之后，界面上还留着上一批题目
     * 答没答过的痕迹。 */
    function setClassNoteQuiz(id, quiz) {
      const note = findClassNote(id);
      if (!note) return null;
      note.quiz = Array.isArray(quiz) ? quiz.map((q) => ({ ...q, selectedIndex: null })) : [];
      touchClassNote(note);
      persist();
      return note;
    }

    /** 记录学生在测验第 questionIndex 题选的答案下标；题目不存在时安全地什么都不做。 */
    function setClassNoteQuizAnswer(id, questionIndex, selectedIndex) {
      const note = findClassNote(id);
      if (!note) return null;
      const list = note.quiz || [];
      const q = list[questionIndex];
      if (!q) return note;
      q.selectedIndex = selectedIndex;
      touchClassNote(note);
      persist();
      return note;
    }

    /** 给这条笔记的问答记录追加一条消息（role 是 "user" 或 "assistant"）；空文本不追加。 */
    function addClassNoteQaMessage(id, role, text) {
      const note = findClassNote(id);
      if (!note) return null;
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (!trimmed) return note;
      note.qaMessages = [...(note.qaMessages || []), { role, text: trimmed }];
      touchClassNote(note);
      persist();
      return note;
    }

    /** 给这条笔记添加一份上传的材料（图片、解析好的 PPT 或 Word 文本）。material 需要带 kind，
     * id 由这里自动生成（跟录音的音频、笔记本身用同一个 uuid()）。返回新增的这条 material。 */
    function addClassNoteMaterial(id, material) {
      const note = findClassNote(id);
      if (!note) return null;
      const kind = material && ["pptx", "docx"].includes(material.kind) ? material.kind : "image";
      const item = {
        id: uuid(),
        kind,
        name: (material && material.name) || "",
        addedAt: new Date().toISOString(),
        storageKey: (material && material.storageKey) || null,
        extractedText: (material && typeof material.extractedText === "string") ? material.extractedText : "",
      };
      note.materials = [...(note.materials || []), item];
      touchClassNote(note);
      persist();
      return item;
    }

    /** 删除这条笔记里的一份材料（按 materialId）；IndexedDB 里对应的图片 Blob 由调用方
     * 自己负责删（这里只管 store.js 这边的 localStorage 记录，跟 audioKey 的处理方式一致）。 */
    function removeClassNoteMaterial(id, materialId) {
      const note = findClassNote(id);
      if (!note) return null;
      note.materials = (note.materials || []).filter((m) => m.id !== materialId);
      touchClassNote(note);
      persist();
      return note;
    }

    /** 保存 AI 根据笔记正文（和材料）生成的思维导图（整段替换，重新生成会覆盖上一份）。 */
    function setClassNoteMindMap(id, mindMap) {
      const note = findClassNote(id);
      if (!note) return null;
      note.mindMap = mindMap && typeof mindMap === "object" ? mindMap : null;
      touchClassNote(note);
      persist();
      return note;
    }

    /** 修改互译目标语言列表（整段替换）：录音开始时没选语言、或者中途想再加一种语言，
     * 都通过这个函数改；改完之后调用方（classNotes.js）负责把新加的语言对已有转录内容
     * 做一次补翻译——这里只管更新"要翻成哪些语言"这个列表本身。 */
    function setClassNoteTargetLangs(id, targetLangs) {
      const note = findClassNote(id);
      if (!note) return null;
      const list = Array.isArray(targetLangs) ? targetLangs.filter((l) => l && l !== note.sourceLang) : [];
      note.targetLangs = [...new Set(list)];
      touchClassNote(note);
      persist();
      return note;
    }

    /** 把这条笔记归到某个课程下（courseId 传 null 就是移回"未分类"）。 */
    function setClassNoteCourseId(id, courseId) {
      const note = findClassNote(id);
      if (!note) return null;
      note.courseId = courseId || null;
      touchClassNote(note);
      persist();
      return note;
    }

    /**
     * 保存"整体重新识别"的结果（整段替换，重新识别一次会覆盖上一次的结果）。
     * 传 null/非对象会清空这份重新识别结果，回到"还没重新识别过"的状态。
     * translations 每次都从空对象开始——重新识别出来的转录内容变了，之前对着旧内容
     * 翻译的结果不能继续用，需要重新翻译（由调用方决定要不要马上重新翻）。
     */
    function setClassNoteRetranscript(id, retranscript) {
      const note = findClassNote(id);
      if (!note) return null;
      if (retranscript && typeof retranscript === "object") {
        note.retranscript = {
          provider: retranscript.provider || "",
          segments: Array.isArray(retranscript.segments) ? retranscript.segments : [],
          translations: {},
          generatedAt: new Date().toISOString(),
        };
      } else {
        note.retranscript = null;
      }
      touchClassNote(note);
      persist();
      return note;
    }

    /** 保存"重新识别"版本翻译成某个目标语言的结果（整段替换）；还没生成过重新识别结果时
     * 安全地什么都不做（没有 retranscript 容器可以挂翻译）。 */
    function setClassNoteRetranscriptTranslation(id, lang, segments) {
      const note = findClassNote(id);
      if (!note || !note.retranscript) return null;
      note.retranscript.translations = { ...(note.retranscript.translations || {}), [lang]: Array.isArray(segments) ? segments : [] };
      touchClassNote(note);
      persist();
      return note;
    }

    function renameClassNote(id, title) {
      const note = findClassNote(id);
      if (!note) return null;
      note.title = title || "";
      touchClassNote(note);
      persist();
      return note;
    }

    function removeClassNote(id) {
      state.classNotes = state.classNotes.filter((n) => n.id !== id);
      persist();
    }

    /** 最新的在前面。用数组插入顺序倒转而不是按 createdAt 时间戳排序——两条笔记如果
     * 在同一毫秒内连续创建（比如自动化测试里），时间戳会完全相同，排序结果就不可靠了；
     * 数组本身的插入顺序才是绝对可靠的先后关系（同样的写法见 listBookNotes）。
     * courseId 不传：返回所有笔记（老行为，不受"课程"分组功能影响）；传具体值
     * （包括 null，代表"未分类"）：只返回归到这个课程下的笔记。 */
    function listClassNotes(courseId) {
      const all = [...state.classNotes].reverse();
      if (courseId === undefined) return all;
      return all.filter((n) => (n.courseId || null) === courseId);
    }

    // ---------- 课堂笔记：课程分组 ----------
    function addClassNoteCourse(name) {
      const c = { id: uuid(), name: (name || "").trim() || "未命名课程", createdAt: new Date().toISOString() };
      state.classNoteCourses.push(c);
      persist();
      return c;
    }
    function renameClassNoteCourse(id, name) {
      const c = state.classNoteCourses.find((x) => x.id === id);
      if (!c) return null;
      const trimmed = (name || "").trim();
      if (trimmed) c.name = trimmed;
      persist();
      return { ...c };
    }
    /** 删除课程不会删掉这门课下面的笔记，只是把它们的 courseId 清空（归到"未分类"），
     * 跟"删除记账账户不删记录、删库存物品保留消耗历史"是同一套不丢数据的原则。 */
    function removeClassNoteCourse(id) {
      state.classNoteCourses = state.classNoteCourses.filter((c) => c.id !== id);
      state.classNotes.forEach((n) => { if (n.courseId === id) n.courseId = null; });
      persist();
    }
    function listClassNoteCourses() {
      return [...state.classNoteCourses];
    }
    /** 课程列表页要展示每门课有几次课堂笔记、最近一次更新是什么时候，这里一次算好，
     * 按最近更新时间倒序排列（跟"最近用到的排前面"这个全站习惯一致）。 */
    function listClassNoteCoursesWithStats() {
      return state.classNoteCourses
        .map((c) => {
          const notes = state.classNotes.filter((n) => n.courseId === c.id);
          const lastUpdatedAt = notes.reduce((max, n) => (n.updatedAt > max ? n.updatedAt : max), "");
          return { ...c, noteCount: notes.length, lastUpdatedAt: lastUpdatedAt || null };
        })
        .sort((a, b) => (b.lastUpdatedAt || "").localeCompare(a.lastUpdatedAt || ""));
    }

    // ---------- 设置 ----------
    function getSettings() {
      return {
        ...state.settings,
        homeCards: { ...state.settings.homeCards },
        profile: { ...state.settings.profile },
      };
    }
    function updateHomeCardVisibility(key, visible) {
      state.settings.homeCards[key] = visible;
      persist();
    }
    function setLastBackupAt(iso) {
      state.settings.lastBackupAt = iso;
      persist();
    }
    /** 字体字号：small/medium/large/xlarge 四档，非法值直接忽略（不写入、不报错）。 */
    function setFontScale(scale) {
      if (!FONT_SCALES.includes(scale)) return;
      state.settings.fontScale = scale;
      persist();
    }
    /** 白天/夜间（护眼）主题。 */
    function setTheme(theme) {
      if (!THEMES.includes(theme)) return;
      state.settings.theme = theme;
      persist();
    }
    function toggleTheme() {
      setTheme(state.settings.theme === "day" ? "night" : "day");
      return state.settings.theme;
    }
    /** Claude API 密钥（整理笔记用）：纯本地存储，传什么存什么（去掉首尾空格），传空字符串等于清空。 */
    function setClaudeApiKey(key) {
      state.settings.claudeApiKey = typeof key === "string" ? key.trim() : "";
      persist();
    }
    /** 当前生效的翻译服务：google/azure/deepl 三选一，非法值直接忽略（不写入、不报错）。 */
    function setTranslationProvider(provider) {
      if (!TRANSLATION_PROVIDER_OPTIONS.some((p) => p.code === provider)) return;
      state.settings.translationProvider = provider;
      persist();
    }
    function setGoogleTranslateApiKey(key) {
      state.settings.googleTranslateApiKey = typeof key === "string" ? key.trim() : "";
      persist();
    }
    function setAzureTranslatorApiKey(key) {
      state.settings.azureTranslatorApiKey = typeof key === "string" ? key.trim() : "";
      persist();
    }
    /** Azure 验证请求除了密钥还要求带上"资源区域"（创建资源时选的那个区域，比如 eastasia）。 */
    function setAzureTranslatorRegion(region) {
      state.settings.azureTranslatorRegion = typeof region === "string" ? region.trim() : "";
      persist();
    }
    function setDeeplApiKey(key) {
      state.settings.deeplApiKey = typeof key === "string" ? key.trim() : "";
      persist();
    }
    /** "整体重新识别"用哪家语音转文字服务：google/azure 二选一，非法值直接忽略。 */
    function setSttProvider(provider) {
      if (!STT_PROVIDER_OPTIONS.some((p) => p.code === provider)) return;
      state.settings.sttProvider = provider;
      persist();
    }
    function setGoogleSpeechApiKey(key) {
      state.settings.googleSpeechApiKey = typeof key === "string" ? key.trim() : "";
      persist();
    }
    function setAzureSpeechApiKey(key) {
      state.settings.azureSpeechApiKey = typeof key === "string" ? key.trim() : "";
      persist();
    }
    function setAzureSpeechRegion(region) {
      state.settings.azureSpeechRegion = typeof region === "string" ? region.trim() : "";
      persist();
    }
    /** 更新个人资料（昵称/头像），patch 里只传要改的字段就行，另一个字段保持不变。 */
    function updateProfile(patch) {
      state.settings.profile = { ...state.settings.profile, ...patch };
      persist();
      return { ...state.settings.profile };
    }
    /**
     * 手动保存：平时每次增删改都会自动存进 localStorage，这个函数是给用户一个"我手动点了保存"的
     * 确定感（也顺便再存一次，万一之前哪次自动保存因为某些原因没触发，这里能兜底）。
     */
    function manualSave() {
      state.settings.lastManualSaveAt = new Date().toISOString();
      persist();
      return state.settings.lastManualSaveAt;
    }

    // ---------- 备份 / 恢复 / 清空 ----------
    function exportBackup() {
      return JSON.stringify({ schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), data: state });
    }
    function importBackup(jsonString) {
      let parsed;
      try {
        parsed = JSON.parse(jsonString);
      } catch {
        throw new Error("备份文件不是合法的 JSON");
      }
      if (!parsed || typeof parsed !== "object" || !("data" in parsed) || !("schemaVersion" in parsed)) {
        throw new Error("备份文件缺少必要字段（schemaVersion / data）");
      }
      if (!isValidDataShape(parsed.data)) {
        throw new Error("备份文件的数据结构不完整");
      }
      state = { ...defaultState(), ...parsed.data };
      state.settings = mergeSettingsDefaults(parsed.data.settings);
      setLastBackupAt(new Date().toISOString());
      persist();
    }
    function resetAll() {
      state = defaultState();
      persist();
    }

    return {
      init, getState, persist,
      addQuickNote, removeQuickNote, listQuickNotes,
      addTodayPlanItem, toggleTodayPlanDone, removeTodayPlanItem, listTodayPlan, updateTodayPlanItem, listTodayPlanRange,
      rolloverUnfinishedTodayPlan,
      startTodayPlanTimer, pauseTodayPlanTimer, finishTodayPlanItem, setTodayPlanSatisfaction,
      linkAssignmentToToday, linkReminderToToday,
      addCourse, removeCourse, listCourses,
      addAssignment, updateAssignment, removeAssignment, listAssignments, listUpcomingAssignments,
      addGoal, removeGoal, listGoals, checkinGoal, isCheckedIn, countCheckins, setDailyLog, getDailyLog,
      startGoalTimer, pauseGoalTimer, listGoalsWithTodayFocus, listStudyTimeSeries,
      addReminder, updateReminder, removeReminder, markReminderDone, listReminders, listRemindersWithNextDate,
      setMealEntry, getMealEntry, getMealEntryRecord, listMealEntriesForWeek, copyWeek,
      addRecipe, updateRecipe, removeRecipe, listRecipes, findRecipe, setMealEntryFromRecipe,
      generateShoppingListFromMealPlan,
      addInventoryItem, updateInventoryItem, removeInventoryItem, listInventoryItems, isLowStock,
      addShoppingItem, removeShoppingItem, listShoppingItems, syncShoppingListFromLowStock,
      resolveShoppingItem, recordConsumption, listTopConsumedItems,
      addTransaction, updateTransaction, removeTransaction, listTransactions, addCategory, removeCategory, listCategories,
      setBudget, removeBudget, getBudgets, getBudgetStatus, listMonthlyTotals,
      addAccount, updateAccount, removeAccount, listAccounts, getAccountBalance, listAccountsWithBalance,
      getExchangeRates, setExchangeRate, setExchangeRates, getExchangeRatesUpdatedAt, CURRENCIES,
      addGame, updateGame, removeGame, listGames, addPlaySession, listSessions, totalMinutesForGame,
      listGamePlaytimeSeries, listTopPlayedGames, findGame,
      addBook, updateBook, removeBook, listBooks, findBook,
      addBookNote, removeBookNote, listBookNotes, countBookNotes, listBooksFinishedSeries,
      addClassNote, findClassNote, appendClassNoteTranscript, finishClassNoteRecording,
      setClassNoteTranslation, appendClassNoteTranslation, setClassNoteMarkdown, setClassNoteNotesTranslation,
      setClassNoteFlashcards, setClassNoteQuiz, setClassNoteQuizAnswer, addClassNoteQaMessage,
      addClassNoteMaterial, removeClassNoteMaterial, setClassNoteMindMap,
      setClassNoteTargetLangs, setClassNoteCourseId, setClassNoteRetranscript, setClassNoteRetranscriptTranslation,
      addClassNoteCourse, renameClassNoteCourse, removeClassNoteCourse, listClassNoteCourses, listClassNoteCoursesWithStats,
      renameClassNote, removeClassNote, listClassNotes,
      getSettings, updateHomeCardVisibility, setLastBackupAt, manualSave,
      setFontScale, setTheme, toggleTheme, updateProfile,
      setClaudeApiKey, setTranslationProvider,
      setGoogleTranslateApiKey, setAzureTranslatorApiKey, setAzureTranslatorRegion, setDeeplApiKey,
      setSttProvider, setGoogleSpeechApiKey, setAzureSpeechApiKey, setAzureSpeechRegion,
      FONT_SCALES, THEMES, AVATAR_OPTIONS, BOOK_STATUSES, CLASS_NOTE_LANGUAGES,
      TRANSLATION_PROVIDER_OPTIONS, STT_PROVIDER_OPTIONS,
      exportBackup, importBackup, resetAll,
    };
  }

  function browserLocalStorageAdapter() {
    return {
      getItem: (k) => globalThis.localStorage.getItem(k),
      setItem: (k, v) => globalThis.localStorage.setItem(k, v),
    };
  }

  /** 应用运行时使用的默认单例，基于浏览器的 localStorage。 */
  const store = createStore(browserLocalStorageAdapter());

  return {
    STORAGE_KEY, SCHEMA_VERSION, createStore, store,
    FONT_SCALES, THEMES, AVATAR_OPTIONS, APP_NAME, BOOK_STATUSES, CLASS_NOTE_LANGUAGES,
    TRANSLATION_PROVIDER_OPTIONS, STT_PROVIDER_OPTIONS,
  };
});
