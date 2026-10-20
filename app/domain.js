/* ============================================================================
   Домен тренажёра: чистые функции без DOM, хранилища и Capacitor.
   Один и тот же файл грузится браузером (глобальная Domain) и тестами (require).
   Здесь живут правила, которые должны быть верны всегда: интервалы повторения,
   подсчёт экзамена, серия дней, нормализация прогресса.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Domain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------ константы -------------------------------- */
  const SUBJECTS = [
    { id: 'history',  ru: 'История',  en: 'History',  ka: 'ისტორია', uk: 'Історія' },
    { id: 'language', ru: 'Язык',     en: 'Language', ka: 'ქართული ენა', uk: 'Мова' },
    { id: 'law',      ru: 'Право',    en: 'Law',      ka: 'სამართალი', uk: 'Право' },
  ];
  // Прототип отвязан намеренно: с обычным объектом SUBJ['toString'] вернул бы
  // унаследованную функцию, и подсунутый в импорте subject:'toString' прошёл бы
  // проверку, а потом уронил рендер на SUBJ[subject].ru
  const SUBJ = Object.assign(Object.create(null), Object.fromEntries(SUBJECTS.map(s => [s.id, s])));
  const BLOCK_SIZE = 10;
  const PASS_MARK = 7;
  const BLOCK_SECONDS = 20 * 60;
  const BOX_INTERVALS = [0, 1, 3, 7, 16, 35];   // Leitner: дни до следующего показа
  const LEECH_AT = 3;                            // 3 ошибки → «проблемный» вопрос
  const MAX_BOX = BOX_INTERVALS.length - 1;
  const SCHEMA_VERSION = 2;
  const KNOWN_BOX = 3;                           // с этого уровня вопрос считаем выученным
  const HISTORY_DAYS = 90;                       // сколько дней активности хранить
  // шаги пути к гражданству («Мой путь»); done хранит дату отметки
  const PATH_STEPS = ['basis', 'register', 'test', 'result', 'apply', 'interview', 'oath'];
  // что просят сделать следующим: собеседование, аудио, украинский, тренажёр ПДД
  const VOTE_IDS = ['interview', 'audio', 'uk']; // «ПДД» убран 16.09: другой продукт, обещать нечего
  const NOTE_MAX = 500;                          // длина заметки к вопросу

  /* -------------------------------- даты ----------------------------------- */
  const today = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  // Дата обязана быть настоящей: '2026-13-40' формально совпадает с шаблоном,
  // но Date его молча нормализует, и срок повтора уезжает на месяцы вперёд.
  const isDateStr = s => {
    if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    const probe = new Date(Date.UTC(y, m - 1, d));
    return probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  };

  const dayNum = s => {
    const [y, m, d] = String(s).split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  };

  // Дату собираем в ЛОКАЛЬНОМ времени: Date из UTC-полуночи в западных зонах
  // (вся Америка) отдаёт предыдущий день, и интервалы повторения уезжали на сутки.
  const addDays = (s, n) => {
    const [y, m, d] = String(s).split('-').map(Number);
    return today(new Date(y, m - 1, d + n));
  };

  /* --------------------------------- SRS ----------------------------------- */
  const blankCard = () => ({ box: 0, due: null, right: 0, wrong: 0, seen: 0, unsure: 0 });

  // Ответ на карточку: верный поднимает уровень, ошибка сбрасывает в начало.
  // opts.chosen — индекс выбранного варианта (при ошибке запоминаем, с чем путают),
  // opts.sure — человек был уверен: уверенная ошибка считается отдельно
  // (гиперкоррекция: такие ошибки запоминаются лучше всего, их стоит показать).
  function gradeCard(card, correct, todayStr, opts = {}) {
    const c = { ...blankCard(), ...card };
    c.seen++;
    if (correct) { c.right++; c.box = Math.min(c.box + 1, MAX_BOX); }
    else {
      c.wrong++; c.box = 0;
      if (Number.isInteger(opts.chosen) && opts.chosen >= 0 && opts.chosen < 4) {
        c.miss = { ...(c.miss || {}) };
        c.miss[opts.chosen] = (c.miss[opts.chosen] || 0) + 1;
      }
      if (opts.sure === true) c.sureWrong = (c.sureWrong || 0) + 1;
    }
    c.due = addDays(todayStr, BOX_INTERVALS[c.box]);
    return c;
  }

  // Самый частый неверный вариант — «с чем путают»; null, если ошибок не было.
  function confusedWith(card) {
    const m = card?.miss; if (!m) return null;
    let best = null, n = 0;
    for (const [k, v] of Object.entries(m)) if (v > n) { n = v; best = +k; }
    return best;
  }

  // «Угадал»: верный ответ не считается знанием — вопрос возвращается завтра.
  function unsureCard(card, todayStr) {
    const c = { ...blankCard(), ...card };
    c.unsure = (c.unsure || 0) + 1;
    c.box = Math.min(c.box, 1);
    c.seen = Math.max(1, c.seen); // иначе карточка осталась бы «новой» и вернулась сегодня же
    c.due = addDays(todayStr, 1);
    return c;
  }

  // Непонятный срок трактуем как «пора повторить»: лучше показать вопрос лишний
  // раз, чем потерять его из плана навсегда.
  const cardIsDue = (card, todayStr) => {
    const c = card || blankCard();
    return c.seen === 0 || !isDateStr(c.due) || dayNum(c.due) <= dayNum(todayStr);
  };
  const cardIsLeech = card => (card?.wrong || 0) >= LEECH_AT;
  const cardIsNew = card => !card || card.seen === 0;

  /* ------------------------------- серия дней ------------------------------- */
  // Серия 2.0. Заморозки (до MAX_FREEZES) зарабатываются закрытой целью дня и
  // списываются за пропущенные дни — серия продолжается. Если заморозок не хватило,
  // серия обрывается, но запоминается (lostStreak/lostOn): в ближайшие EARNBACK_DAYS
  // её можно вернуть двойной нормой (earnBack). Раньше серия тихо прощала один день,
  // и человек этого не видел; теперь прощение — явная и заметная валюта.
  const MAX_FREEZES = 2, EARNBACK_DAYS = 7, MIN_LOST_STREAK = 3;
  const gapDays = (stats, todayStr) => (stats.lastDay ? dayNum(todayStr) - dayNum(stats.lastDay) - 1 : null);

  // Занятие сегодня: продолжает серию, если прошлое было вчера или пропуск покрыт заморозками.
  function nextStreak(stats, todayStr) {
    if (stats.lastDay === todayStr) return { ...stats };
    const gap = gapDays(stats, todayStr);
    let freezes = Math.max(0, stats.freezes || 0);
    let streakDays;
    const out = { ...stats };
    if (gap === null) streakDays = 1;
    else if (gap < 0) streakDays = 1; // дата из будущего (часы переводили) — серию не наращиваем
    else if (gap === 0) streakDays = (stats.streakDays || 0) + 1;
    else if (gap <= freezes) { freezes -= gap; streakDays = (stats.streakDays || 0) + 1; }
    else {
      streakDays = 1;
      // потерянная серия, которую ещё можно вернуть, не должна затираться более короткой
      const prev = isDateStr(stats.lostOn) && dayNum(todayStr) - dayNum(stats.lostOn) <= EARNBACK_DAYS ? (stats.lostStreak || 0) : 0;
      const cur = stats.streakDays || 0;
      if (cur >= MIN_LOST_STREAK || prev) {
        if (cur >= prev) { out.lostStreak = cur; out.lostOn = todayStr; }
        else { out.lostStreak = prev; out.lostOn = stats.lostOn; }
      }
    }
    return {
      ...out,
      streakDays,
      bestStreak: Math.max(stats.bestStreak || 0, streakDays),
      lastDay: todayStr,
      freezes,
    };
  }

  // Серия «жива», пока пропуск покрыт заморозками (без заморозок — ни одного дня пропуска
  // не прощается в показе, хотя один день раньше прощался молча: теперь он стоит заморозку).
  function liveStreak(stats, todayStr) {
    if (!stats || !stats.lastDay) return 0;
    const gap = gapDays(stats, todayStr);
    return gap <= Math.max(0, stats.freezes || 0) ? (stats.streakDays || 0) : 0;
  }

  // Закрытая цель дня даёт заморозку (не больше MAX_FREEZES).
  function earnFreeze(stats) {
    return { ...stats, freezes: Math.min(MAX_FREEZES, Math.max(0, stats.freezes || 0) + 1) };
  }

  // Вернуть оборванную серию: в течение EARNBACK_DAYS после обрыва — двойная норма за день.
  function canEarnBack(stats, todayStr, doneToday, goal) {
    if (!stats || !stats.lostStreak || !isDateStr(stats.lostOn)) return false;
    if (dayNum(todayStr) - dayNum(stats.lostOn) > EARNBACK_DAYS) return false;
    return doneToday >= 2 * goal;
  }
  function earnBack(stats) {
    const restored = (stats.lostStreak || 0) + (stats.streakDays || 0);
    return { ...stats, streakDays: restored, bestStreak: Math.max(stats.bestStreak || 0, restored), lostStreak: 0, lostOn: null };
  }

  // Идеальные дни подряд (цель закрыта): семь — «золотая неделя».
  function markPerfectDay(stats, todayStr) {
    if (stats.perfectDay === todayStr) return { ...stats };
    const cont = stats.perfectDay && dayNum(todayStr) - dayNum(stats.perfectDay) === 1;
    const perfectDays = cont ? (stats.perfectDays || 0) + 1 : 1;
    return { ...stats, perfectDays, perfectDay: todayStr, bestPerfect: Math.max(stats.bestPerfect || 0, perfectDays) };
  }
  const GOLD_WEEK = 7;
  const isGoldWeek = (stats, todayStr) => (stats.perfectDays || 0) >= GOLD_WEEK && !!stats.perfectDay && dayNum(todayStr) - dayNum(stats.perfectDay) <= 1;

  /* -------------------------------- экзамен --------------------------------- */
  // Считаем блоки: неотвеченный вопрос — ошибка. Сдано только если КАЖДЫЙ блок ≥ 7.
  function scoreExam(blocks) {
    const perSubject = {};
    if (!Array.isArray(blocks) || blocks.length === 0) return { blocks: perSubject, passed: false };
    let passed = true;
    for (const blk of blocks) {
      let right = 0;
      for (const q of blk.queue) {
        const given = blk.answers.get(`${q.subject}:${q.id}`);
        // сравниваем только заданные ответы: у битого вопроса correct может быть
        // undefined, и пропуск засчитался бы как верный ответ
        if (given != null && given === q.correct) right++;
      }
      // если предмет встретился дважды, в отчёте остаётся худший блок
      perSubject[blk.subject] = perSubject[blk.subject] == null
        ? right
        : Math.min(perSubject[blk.subject], right);
      if (right < PASS_MARK) passed = false;
    }
    return { blocks: perSubject, passed };
  }

  const failedSubjects = scored =>
    Object.entries(scored.blocks).filter(([, v]) => v < PASS_MARK).map(([k]) => k);

  /* ------------------------------ готовность -------------------------------- */
  // Прогноз балла из 10: выученные дают почти гарантию, виденные — свою точность,
  // новые — вероятность угадать из четырёх вариантов.
  function readiness(cards, total) {
    if (!total) return 0;
    let known = 0, seenRight = 0, seenTries = 0, seenCount = 0;
    for (const c of cards) {
      if (!c || c.seen === 0) continue;
      if (c.box >= KNOWN_BOX) { known++; continue; }
      seenCount++;
      seenRight += c.right || 0;
      seenTries += (c.right || 0) + (c.wrong || 0);
    }
    // Вес начатой карточки не может превышать вес выученной: иначе третий верный
    // ответ подряд переводил бы вопрос в «выученные» и ронял прогноз.
    const acc = Math.min(seenTries ? seenRight / seenTries : 0.25, 0.9);
    const fresh = Math.max(0, total - known - seenCount);
    return 10 * (0.9 * known + acc * seenCount + 0.25 * fresh) / total;
  }

  // Три состояния вместо ложно точного процента: прогноз — оценка балла, а не
  // калиброванная вероятность. Порог сдачи 7, «скорее сдашь» — с запасом в балл.
  const READY_LIKELY = 8, READY_COIN = 6.5;
  const readinessState = score => (score >= READY_LIKELY ? 'likely' : score >= READY_COIN ? 'coin' : 'early');

  // Сколько ещё вопросов выучить (уровень 3+), чтобы прогноз дошёл до target.
  // План отдаёт сначала начатые карточки, потом новые: начатая при выучивании даёт
  // (0.9 − точность) балла из total, новая — 0.9 − 0.25. Считаем в том же порядке.
  function toLearnFor(cards, total, target = READY_LIKELY) {
    if (!total) return 0;
    const score = readiness(cards, total);
    if (score >= target) return 0;
    let known = 0, seenCount = 0, seenRight = 0, seenTries = 0;
    for (const c of cards) {
      if (!c || c.seen === 0) continue;
      if (c.box >= KNOWN_BOX) { known++; continue; }
      seenCount++; seenRight += c.right || 0; seenTries += (c.right || 0) + (c.wrong || 0);
    }
    const acc = Math.min(seenTries ? seenRight / seenTries : 0.25, 0.9);
    let need = target - score, n = 0;
    const gainSeen = (0.9 - acc) * 10 / total;
    if (seenCount > 0 && gainSeen > 0) {
      const k = Math.min(seenCount, Math.ceil(need / gainSeen));
      if (k * gainSeen >= need) return k;
      n += seenCount; need -= seenCount * gainSeen;
    }
    const gainNew = (0.9 - 0.25) * 10 / total;
    return Math.min(total - known, n + Math.ceil(need / gainNew));
  }

  /* ------------------- детерминированная случайность ------------------------ */
  // mulberry32: один seed — один и тот же набор вопросов на любом устройстве
  // (экзамен дня для всех, вызов другу по коду).
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seededSample(arr, n, seed) {
    const r = rng(seed), a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, n);
  }
  // Код вызова — seed в base36 (до 5 знаков, заглавные); регистр и мусор не важны.
  // Длиннее пяти не принимаем: такой seed не влезает в код, и друг получил бы другой набор.
  const CODE_SPACE = 36 ** 5;
  const codeFromSeed = seed => Math.floor(Math.abs(seed) % CODE_SPACE).toString(36).toUpperCase().padStart(5, '0');
  function seedFromCode(code) {
    const c = String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (c.length < 3 || c.length > 5) return null;
    const n = parseInt(c, 36);
    return Number.isFinite(n) ? n : null;
  }
  const dailySeed = todayStr => dayNum(todayStr) * 7919 + 17; // общий для всех в этот день

  // Последние дни перед экзаменом: новых вопросов не даём, повторяем ошибки и просроченное.
  const FINAL_DAYS = 2;
  const isFinalStretch = (examDate, todayStr) => isDateStr(examDate) && daysUntil(examDate, todayStr) >= 0 && daysUntil(examDate, todayStr) <= FINAL_DAYS;

  // Шанс сдать все блоки: прогноз балла r/10 читаем как вероятность верного ответа на
  // случайный вопрос, блок — 10 независимых попыток, порог PASS_MARK; блоки независимы.
  // Это оценка модели по прогрессу, не статистика сдач — так и подписываем.
  function blockPassChance(score) {
    const p = Math.max(0, Math.min(1, score / 10));
    let sum = 0;
    for (let k = PASS_MARK; k <= BLOCK_SIZE; k++) {
      let c = 1; for (let i = 1; i <= k; i++) c = c * (BLOCK_SIZE - k + i) / i; // C(10, k)
      sum += c * p ** k * (1 - p) ** (BLOCK_SIZE - k);
    }
    return sum;
  }
  const passChance = scores => scores.reduce((acc, r) => acc * blockPassChance(r), 1);

  /* ------------------------------ достижения -------------------------------- */
  // Тихие бейджи: считаются из прогресса задним числом, поэтому ничего не
  // ломается у тех, кто начал раньше. extra: { learned, weakSections } — из банка.
  const BADGES = [
    { id: 'first',        test: (p) => p.stats.answered >= 1 },
    { id: 'answers-100',  test: (p) => p.stats.answered >= 100 },
    { id: 'answers-500',  test: (p) => p.stats.answered >= 500 },
    { id: 'answers-1500', test: (p) => p.stats.answered >= 1500 },
    { id: 'streak-3',     test: (p) => p.stats.bestStreak >= 3 },
    { id: 'streak-7',     test: (p) => p.stats.bestStreak >= 7 },
    { id: 'streak-30',    test: (p) => p.stats.bestStreak >= 30 },
    { id: 'gold-week',    test: (p) => (p.stats.bestPerfect || 0) >= GOLD_WEEK },
    { id: 'exam-pass',    test: (p) => p.stats.examsPassed >= 1 },
    { id: 'exam-strong',  test: (p) => p.exams.some(e => ['language', 'history', 'law'].every(k => (e.blocks[k] ?? 0) >= 9)) },
    { id: 'learned-100',  test: (p, x) => (x.learned || 0) >= 100 },
    { id: 'learned-300',  test: (p, x) => (x.learned || 0) >= 300 },
    { id: 'learned-all',  test: (p, x) => (x.learned || 0) >= 600 },
    { id: 'no-weak',      test: (p, x) => x.weakSections === 0 && (x.learned || 0) >= 100 },
  ];
  const badges = (p, extra = {}) => BADGES.map(b => ({ id: b.id, earned: !!b.test(p, extra) }));

  /* --------------------------- план подготовки ------------------------------ */
  // Сколько новых вопросов в день нужно брать, чтобы пройти весь банк до экзамена.
  // Запас 1.15 — на пропущенные дни; без даты экзамена возвращаем текущую норму.
  function planDailyNew(newLeft, examDate, todayStr, fallback) {
    if (!examDate) return fallback;
    const days = dayNum(examDate) - dayNum(todayStr);
    if (days <= 0) return Math.min(200, Math.max(10, newLeft || fallback));
    return Math.min(200, Math.max(10, Math.ceil(newLeft * 1.15 / days)));
  }

  // Дата, к которой банк будет пройден при текущей норме.
  function forecastFinishDate(newLeft, perDay, todayStr) {
    if (!newLeft) return todayStr;
    return addDays(todayStr, Math.ceil(newLeft / Math.max(1, perDay)));
  }

  const daysUntil = (dateStr, todayStr) => dayNum(dateStr) - dayNum(todayStr);

  // Русское склонение при числе: [1, 2-4, 5+] — «1 вопрос, 23 вопроса, 25 вопросов».
  // При переходе на i18next заменится на встроенные правила Intl.PluralRules.
  function plural(n, forms) {
    const abs = Math.abs(n) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return forms[2];
    if (last > 1 && last < 5) return forms[1];
    if (last === 1) return forms[0];
    return forms[2];
  }

  /* ------------------------------- прогресс --------------------------------- */
  function blankProgress() {
    return {
      v: SCHEMA_VERSION,
      updatedAt: 0,
      srs: {},
      starred: [],
      stats: { answered: 0, correct: 0, examsPassed: 0, examsTaken: 0, streakDays: 0, bestStreak: 0, lastDay: null, todayDay: null, todayCount: 0, history: {}, votes: {}, freezes: 0, lostStreak: 0, lostOn: null, perfectDays: 0, perfectDay: null, bestPerfect: 0, quickBest: 0, dailyDay: null, dailyScore: 0, dailyBest: 0, dailyCount: 0, goalDay: null, reviewAsked: {} },
      exams: [],
      notes: {},
      path: { done: {}, registeredOn: null, passedOn: null },      // qKey → заметка пользователя к вопросу
      settings: {
        display: 'ka_ru', shuffle: true, newPerDay: 40, subject: 'law', theme: 'system',
        onboarded: false, examDate: null, transLang: 'ru', uiLang: 'ru',
        reminder: null, // 'HH:MM' — ежедневное напоминание, null — выключено
        textScale: 1,   // размер текста вопросов: 1 | 1.15 | 1.3
        haptics: 'all', // отклик вибрацией: all | results | off
        motion: 'system', // анимации: system | reduced
        ttsRate: 0.85,  // скорость озвучки: 0.7 | 0.85 | 1
        explain: 'auto', // пояснение после ответа: auto | button | off
        procedure: 'full', // full — три предмета; restore — восстановление гражданства, только язык
        strict: false, // экзамен «как на настоящем»: только грузинский, без озвучки и подсказок
      },
    };
  }

  // Жёсткая нормализация: данные могут прийти из чужого файла импорта или из
  // битой копии — каждое поле приводится к типу, иначе берётся из каркаса.
  // Слабый мерж закреплял бы яд в обеих копиях и ломал рендер на каждом запуске.
  function normalizeProgress(p) {
    const out = blankProgress();
    if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
    const obj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    const num = (v, d) => Number.isFinite(+v) && v !== null && v !== '' ? +v : d;

    for (const [k, c] of Object.entries(obj(p.srs))) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
      // JSON.parse создаёт собственное свойство __proto__, и присваивание по
      // такому ключу подменило бы прототип хранилища карточек
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out.srs[k] = {
        box: Math.max(0, Math.min(MAX_BOX, Math.round(num(c.box, 0)))),
        due: isDateStr(c.due) ? c.due : null,
        right: Math.max(0, num(c.right, 0)),
        wrong: Math.max(0, num(c.wrong, 0)),
        seen: Math.max(0, num(c.seen, 0)),
        ...(c.unsure ? { unsure: Math.max(0, num(c.unsure, 0)) } : {}),
        ...(c.sureWrong ? { sureWrong: Math.max(0, Math.round(num(c.sureWrong, 0))) } : {}),
      };
      // с чем путают: индекс варианта 0..3 → число ошибок
      if (c.miss && typeof c.miss === 'object' && !Array.isArray(c.miss)) {
        const miss = {};
        for (const i of [0, 1, 2, 3]) { const n = Math.round(num(c.miss[i], 0)); if (n > 0) miss[i] = n; }
        if (Object.keys(miss).length) out.srs[k].miss = miss;
      }
    }
    out.starred = Array.isArray(p.starred) ? p.starred.filter(x => typeof x === 'string') : [];
    // Экзамены приводим по полям: из чужого файла в blocks может приехать строка
    // с разметкой, а она попадает в innerHTML истории попыток.
    const blocksOf = b => {
      const o = {};
      for (const k of ['language', 'history', 'law']) {
        const v = b[k];
        // только число или числовая строка: true/[]/'  ' через +v тоже дают числа
        const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? +v : NaN);
        if (Number.isFinite(n)) o[k] = Math.max(0, Math.min(BLOCK_SIZE, Math.round(n)));
      }
      return o;
    };
    out.exams = Array.isArray(p.exams)
      ? p.exams
        .filter(e => e && typeof e === 'object' && e.blocks && typeof e.blocks === 'object' && !Array.isArray(e.blocks))
        // v2.2 писала дату в поле date — принимаем оба имени
        .map(e => {
          const out = { day: isDateStr(e.day) ? e.day : isDateStr(e.date) ? e.date : null, blocks: blocksOf(e.blocks), passed: e.passed === true || e.passed === 1 || e.passed === 'true', seconds: Math.max(0, num(e.seconds, 0)) };
          if (typeof e.code === 'string' && /^[0-9A-Z]{3,5}$/.test(e.code)) out.code = e.code; // вызов другу
          return out;
        })
        .filter(e => Object.keys(e.blocks).length > 0)
      : [];

    const st = obj(p.stats);
    for (const k of Object.keys(out.stats)) {
      if (k === 'history' || k === 'votes' || k === 'reviewAsked') continue;
      out.stats[k] = (k === 'lastDay' || k === 'todayDay' || k === 'lostOn' || k === 'perfectDay' || k === 'dailyDay' || k === 'goalDay')
        ? (typeof st[k] === 'string' ? st[k] : null)
        : Math.max(0, num(st[k], out.stats[k]));
    }
    out.stats.freezes = Math.min(MAX_FREEZES, Math.round(out.stats.freezes));
    // когда просили оценку в сторе: событие → дата (не чаще раза на событие)
    const ra = obj(st.reviewAsked);
    for (const k of ['exam', 'passed']) if (isDateStr(ra[k])) out.stats.reviewAsked[k] = ra[k];
    // голоса за будущие функции: только известные ключи, число нажатий
    const votes = obj(st.votes);
    for (const id of VOTE_IDS) { const n = Math.round(num(votes[id], 0)); if (n > 0) out.stats.votes[id] = n; }
    // история активности: дата → число ответов, храним 90 последних дней
    const hist = obj(st.history);
    const days = Object.keys(hist).filter(isDateStr).sort().slice(-HISTORY_DAYS);
    for (const d of days) { const n = Math.max(0, Math.round(num(hist[d], 0))); if (n > 0) out.stats.history[d] = n; }

    // заметки: строка до 500 знаков, ключ — вопрос
    for (const [k, v] of Object.entries(obj(p.notes))) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (typeof v !== 'string') continue;
      const text = v.trim().slice(0, NOTE_MAX);
      if (text) out.notes[k] = text;
    }

    const se = obj(p.settings);
    if (['ru', 'ka_ru', 'ka'].includes(se.display)) out.settings.display = se.display;
    if (['system', 'light', 'dark'].includes(se.theme)) out.settings.theme = se.theme;
    if (SUBJ[se.subject]) out.settings.subject = se.subject;
    if (typeof se.shuffle === 'boolean') out.settings.shuffle = se.shuffle;
    if (typeof se.onboarded === 'boolean') out.settings.onboarded = se.onboarded;
    if (['ru', 'en', 'uk'].includes(se.transLang)) out.settings.transLang = se.transLang;
    if (['ru', 'en', 'ka', 'uk'].includes(se.uiLang)) out.settings.uiLang = se.uiLang;
    if (isDateStr(se.examDate)) out.settings.examDate = se.examDate;
    if (typeof se.reminder === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(se.reminder)) out.settings.reminder = se.reminder;
    if ([1, 1.15, 1.3].includes(+se.textScale)) out.settings.textScale = +se.textScale;
    if (['all', 'results', 'off'].includes(se.haptics)) out.settings.haptics = se.haptics;
    if (['system', 'reduced'].includes(se.motion)) out.settings.motion = se.motion;
    if ([0.7, 0.85, 1].includes(+se.ttsRate)) out.settings.ttsRate = +se.ttsRate;
    if (['auto', 'button', 'off'].includes(se.explain)) out.settings.explain = se.explain;
    if (['full', 'restore'].includes(se.procedure)) out.settings.procedure = se.procedure;
    if (typeof se.strict === 'boolean') out.settings.strict = se.strict;

    // «Мой путь»: отметки шагов и две даты
    const path = obj(p.path);
    for (const [k, v] of Object.entries(obj(path.done))) if (PATH_STEPS.includes(k) && isDateStr(v)) out.path.done[k] = v;
    if (isDateStr(path.registeredOn)) out.path.registeredOn = path.registeredOn;
    if (isDateStr(path.passedOn)) out.path.passedOn = path.passedOn;
    out.settings.newPerDay = Math.max(10, Math.min(200, num(se.newPerDay, out.settings.newPerDay)));

    out.updatedAt = Math.max(0, num(p.updatedAt, 0));
    out.v = SCHEMA_VERSION; // v1 → v2: добавились updatedAt и файловая копия
    return out;
  }

  // У данных v2.2 нет updatedAt — тогда сравниваем по количеству ответов.
  // Пустой профиль — без ответов, карточек, попыток и заметок: после «Сбросить
  // статистику» счётчик ответов нулевой, но карточки на месте — это не пустота.
  const isEmptyProfile = p => !(p.stats?.answered) && !Object.keys(p.srs || {}).length
    && !(Array.isArray(p.exams) && p.exams.length) && !Object.keys(p.notes || {}).length;
  function pickRicher(a, b) {
    if (!a) return b;
    if (!b) return a;
    const aa = a.stats?.answered || 0, ab = b.stats?.answered || 0;
    // Пустой профиль не побеждает наполненный, даже если он свежее. Иначе после
    // неудачной попытки миграции (пустой профиль уже сохранён с текущим временем)
    // данные версии 2.2, у которых updatedAt отсутствует, были бы отброшены.
    const ea = isEmptyProfile(a), eb = isEmptyProfile(b);
    if (ea !== eb) return ea ? b : a;
    const ua = a.updatedAt || 0, ub = b.updatedAt || 0;
    if (ua !== ub) return ua > ub ? a : b;
    return aa >= ab ? a : b;
  }

  function parseProgress(raw) {
    try {
      const p = JSON.parse(raw);
      return p && typeof p === 'object' && !Array.isArray(p) && p.srs && typeof p.srs === 'object' ? p : null;
    } catch { return null; }
  }

  return {
    SUBJECTS, SUBJ, BLOCK_SIZE, PASS_MARK, BLOCK_SECONDS, BOX_INTERVALS,
    LEECH_AT, MAX_BOX, SCHEMA_VERSION, KNOWN_BOX,
    today, dayNum, addDays,
    blankCard, gradeCard, unsureCard, confusedWith, cardIsDue, cardIsLeech, cardIsNew,
    readinessState, toLearnFor, READY_LIKELY, READY_COIN, VOTE_IDS, PATH_STEPS, isFinalStretch, FINAL_DAYS, blockPassChance, passChance,
    rng, seededSample, codeFromSeed, seedFromCode, dailySeed,
    nextStreak, liveStreak, earnFreeze, canEarnBack, earnBack, markPerfectDay, isGoldWeek,
    MAX_FREEZES, EARNBACK_DAYS, GOLD_WEEK,
    scoreExam, failedSubjects, readiness,
    planDailyNew, forecastFinishDate, daysUntil, plural,
    blankProgress, normalizeProgress, pickRicher, parseProgress,
    BADGES, badges, HISTORY_DAYS, NOTE_MAX,
  };
});
