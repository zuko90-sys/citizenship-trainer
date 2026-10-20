/* ============================================================================
   Тренажёр на гражданство Грузии
   600 вопросов из открытого банка агентства (история / язык / право),
   полная симуляция экзамена:
   3 блока по 10 вопросов, 20 минут на блок, порог 7/10 в КАЖДОМ блоке.
   ========================================================================== */

// правила экзамена и повторения живут в domain.js — он же покрыт тестами
const D = window.Domain;
const {
  SUBJECTS, SUBJ, BLOCK_SIZE, PASS_MARK, BLOCK_SECONDS, BOX_INTERVALS, LEECH_AT,
  SCHEMA_VERSION, today, dayNum, addDays, blankProgress, normalizeProgress,
  pickRicher, parseProgress,
} = D;

/* ------------------------------ хранилище --------------------------------- */
const KEY = 'geo-citizenship-trainer-v1';
const mem = {};
// Постоянное хранилище браузера берём динамически: в песочнице превью оно
// недоступно, тогда прогресс живёт в памяти, а переносится файлом.
const persist = (() => {
  try {
    const s = window['local' + 'Storage'];
    s.setItem('__t', '1'); s.removeItem('__t');
    return s;
  } catch { return null; }
})();
const store = {
  ok: !!persist,
  get(k) { try { return persist ? persist.getItem(k) : (mem[k] ?? null); } catch { return mem[k] ?? null; } },
  set(k, v) { try { persist ? persist.setItem(k, v) : (mem[k] = v); } catch { mem[k] = v; } },
  del(k) { try { persist ? persist.removeItem(k) : delete mem[k]; } catch { delete mem[k]; } },
};

/* --- долговременное файловое хранилище (Capacitor Filesystem) ---
   progress.json в Directory.Data переживает чистку WebView-данных, попадает в
   Auto Backup и переносится на новое устройство. localStorage остаётся быстрым
   синхронным кэшем; при расхождении копий побеждает свежая по updatedAt. */
const PROGRESS_FILE = 'progress.json';
const SESSION_KEY = KEY + ':session';
const capFs = () => window.Capacitor?.Plugins?.Filesystem;
// до конца loadProgress() ничего не пишем и не удаляем: ранний lifecycle-ивент
// иначе способен затереть ещё не прочитанный прогресс пустым каркасом
let loaded = false;

async function fileRead(path) {
  const fs = capFs(); if (!fs) return null;
  try {
    const r = await fs.readFile({ path, directory: 'DATA', encoding: 'utf8' });
    return typeof r.data === 'string' ? r.data : null;
  } catch { return null; }
}
async function fileDelete(path) { try { await capFs()?.deleteFile({ path, directory: 'DATA' }); } catch { /* нет файла — ок */ } }

/* Одноразовый перенос прогресса v2.2: плагин LegacyMigration открывает скрытый
   WebView на старом origin file:// и возвращает содержимое его localStorage.
   Флаг успеха ставим только когда плагин реально ответил ok — таймаут или
   ошибка дают повторную попытку на следующем запуске (максимум 3). */
async function readLegacy() {
  const plug = window.Capacitor?.Plugins?.LegacyMigration;
  if (!plug) return null;
  const FLAG = KEY + ':legacy-migrated', ATT = FLAG + ':attempts';
  const attempts = +(store.get(ATT) || 0);
  if (store.get(FLAG) === '1' || attempts >= 3) return null;
  try {
    const r = await plug.read();
    if (r && r.ok) { store.set(FLAG, '1'); return parseProgress(r.data || 'null'); }
  } catch { /* считаем попыткой */ }
  store.set(ATT, String(attempts + 1));
  return null;
}
async function fileWriteAtomic(path, data) {
  const fs = capFs(); if (!fs) return;
  const tmp = path + '.tmp';
  try {
    await fs.writeFile({ path: tmp, directory: 'DATA', encoding: 'utf8', data });
    await fileDelete(path);
    await fs.rename({ from: tmp, to: path, directory: 'DATA', toDirectory: 'DATA' });
  } catch {
    // rename не сработал (редкие прошивки) — пишем напрямую
    try { await fs.writeFile({ path, directory: 'DATA', encoding: 'utf8', data }); } catch { /* диск недоступен */ }
  }
}

let P = blankProgress(); // до loadProgress() — пустой каркас

async function loadProgress() {
  const fromLocal = parseProgress(store.get(KEY));
  const fromFile = parseProgress(await fileRead(PROGRESS_FILE)) || parseProgress(await fileRead(PROGRESS_FILE + '.tmp'));
  const fromLegacy = await readLegacy();
  const winner = pickRicher(pickRicher(fromLocal, fromFile), fromLegacy);
  P = normalizeProgress(winner || blankProgress());
  pruneToBank();
  if (!winner) {
    // первый запуск: язык интерфейса — по языку устройства (английский тянет
    // за собой и перевод; для грузинского перевод остаётся русским)
    // русский — только для русских устройств; грузинский — для грузинских; всем остальным
    // (украинский, турецкий, немецкий…) — английский, не угадываем. Онбординг даёт выбрать.
    const dev = navigator.language || '';
    if (/^ka\b/i.test(dev)) { P.settings.uiLang = 'ka'; }
    else if (/^uk\b/i.test(dev) && hasUkBank()) { P.settings.uiLang = 'uk'; P.settings.transLang = 'uk'; }
    else if (!/^ru\b/i.test(dev)) { P.settings.uiLang = 'en'; P.settings.transLang = 'en'; }
  }
  applyUiLang();
  loaded = true; // с этого момента save/persistSession снова разрешены
  if (fromLegacy && winner === fromLegacy) toast(t('Прогресс из прошлой версии перенесён'));
  // синхронизируем обе копии с победителем
  store.set(KEY, JSON.stringify(P));
  flushProgress();
}

// карточки и заметки с ключами не из банка (чужой файл, старый банк) — выбрасываем
function pruneToBank() {
  for (const k of Object.keys(P.srs)) if (!byKey.has(k)) delete P.srs[k];
  for (const k of Object.keys(P.notes)) if (!byKey.has(k)) delete P.notes[k];
}

let saveTimer = null;
function save() {
  if (!loaded) return; // до загрузки не затираем хранилище пустым каркасом
  P.updatedAt = Date.now();
  store.set(KEY, JSON.stringify(P));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushProgress, 800);
}
// записи в файл строго последовательны: параллельные fileWriteAtomic на одних
// путях могли бы оставить систему вовсе без progress.json
let flushChain = Promise.resolve();
function flushProgress() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const json = JSON.stringify(P);
  flushChain = flushChain.then(() => fileWriteAtomic(PROGRESS_FILE, json)).catch(() => {});
  return flushChain;
}

/* ------------------------- даты, серия, SRS (домен) ------------------------ */
const touchDay = () => {
  const before = P.stats;
  P.stats = D.nextStreak(P.stats, today());
  // первое занятие за день: пропуск покрыт заморозкой — скажем, иначе валюта невидима
  if (before.lastDay !== today() && (before.freezes || 0) > (P.stats.freezes || 0)) {
    toast(t('❄️ Заморозка спасла серию: {0} {1}', [P.stats.streakDays, I18N.plural(P.stats.streakDays, ['день', 'дня', 'дней'])]));
  }
};
const liveStreak = () => D.liveStreak(P.stats, today());

const qKey = q => `${q.subject}:${q.id}`;
const card = q => P.srs[qKey(q)] || D.blankCard();
const isDue = q => D.cardIsDue(card(q), today());
const isLeech = q => D.cardIsLeech(card(q));
const isNew = q => D.cardIsNew(card(q));

function grade(q, correct, opts = {}) {
  const before = card(q).box;
  P.srs[qKey(q)] = D.gradeCard(card(q), correct, today(), opts);
  // для итога занятия: сколько карточек поднялось и сколько вернулось в начало
  if (session?.kind === 'study') {
    if (correct && P.srs[qKey(q)].box > before) session.up = (session.up || 0) + 1;
    if (!correct) session.down = (session.down || 0) + 1;
  }
  touchDay();
  P.stats.answered++;
  if (correct) P.stats.correct++;
  bumpToday();
  save();
}

// Цель дня — дневная норма из настроек; считаем любые ответы за сегодня.
// Ровно на достижении — маленький праздник, один раз в день.
const dailyGoal = () => P.settings.newPerDay;
const doneToday = () => (P.stats.todayDay === today() ? P.stats.todayCount : 0);
function bumpToday() {
  if (P.stats.todayDay !== today()) { P.stats.todayDay = today(); P.stats.todayCount = 0; }
  P.stats.todayCount++;
  // история активности для графика на главной
  const h = P.stats.history || (P.stats.history = {});
  h[today()] = (h[today()] || 0) + 1;
  const days = Object.keys(h).sort();
  while (days.length > D.HISTORY_DAYS) delete h[days.shift()];
  if (P.stats.todayCount === 1) cancelStreakSaver(); // сегодня занимались — вечернее «спасите серию» не нужно
  awardGoal();
  // оборванная серия возвращается двойной нормой в течение недели
  if (D.canEarnBack(P.stats, today(), P.stats.todayCount, dailyGoal())) {
    P.stats = D.earnBack(P.stats);
    haptic('celebrate');
    toast(t('🔥 Серия возвращена: {0} {1}', [P.stats.streakDays, I18N.plural(P.stats.streakDays, ['день', 'дня', 'дней'])]));
    confetti(40);
  }
  if (!badgeHold) checkBadges();
}

// Цель дня закрыта — один раз в день (goalDay), по «≥»: норму могут поменять посреди дня.
// Даёт заморозку (до двух) и идеальный день; зовётся после каждого ответа и после смены нормы.
function awardGoal() {
  if (!(doneToday() >= dailyGoal()) || P.stats.goalDay === today()) return;
  P.stats.goalDay = today();
  haptic('celebrate');
  const had = P.stats.freezes || 0;
  P.stats = D.markPerfectDay(D.earnFreeze(P.stats), today());
  const got = (P.stats.freezes || 0) > had;
  toast(t('Цель дня выполнена — так держать') + (got ? ` · ❄️ +1 (${P.stats.freezes})` : ''));
  if (P.stats.perfectDays === D.GOLD_WEEK) toast(t('✨ Золотая неделя: семь дней подряд с закрытой целью'));
  confetti(40);
  save();
}

// Достижения считаются из прогресса; новые — тост и лёгкая вибрация.
const BADGE_KEY = KEY + ':badges';
function badgeExtra() {
  const learned = QUESTIONS.filter(q => card(q).box >= D.KNOWN_BOX).length;
  let weak = 0;
  SUBJECTS.forEach(s => sectionsOf(s.id).forEach(sec => {
    const qs = bySubject(s.id).filter(q => q.section === sec);
    const seen = qs.filter(q => card(q).seen > 0);
    const acc = pct(seen.reduce((a, q) => a + card(q).right, 0), seen.reduce((a, q) => a + card(q).right + card(q).wrong, 0));
    if (!seen.length || acc < 80) weak++;
  }));
  return { learned, weakSections: weak };
}
// silent — пересчитать без тоста: первый запуск, импорт, сброс (задним числом не шумим)
let badgeHold = false; // на время пакетной оценки экзамена
function checkBadges(silent = false) {
  const earned = D.badges(P, badgeExtra()).filter(b => b.earned).map(b => b.id);
  let seen = null;
  try { seen = JSON.parse(store.get(BADGE_KEY) || 'null'); } catch { seen = null; }
  if (!Array.isArray(seen) || silent) { store.set(BADGE_KEY, JSON.stringify(earned)); return; }
  const fresh = earned.filter(id => !seen.includes(id));
  if (fresh.length) {
    store.set(BADGE_KEY, JSON.stringify(earned));
    toast(t('Новое достижение: {0}', [badgeTitle(fresh[fresh.length - 1])]));
    haptic('celebrate');
  }
}
/* ------------------------------- ИКОНКИ ---------------------------------- */
// Один набор контурных SVG вместо символов Unicode и эмодзи: те на разных Android
// рисуются разными шрифтами (цветной динамик рядом с монохромной звездой).
// 24×24, контур 2px, цвет — currentColor; всегда декоративные (aria-hidden), смысл несёт текст или aria-label.
const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  pencil: '<path d="M17 3l4 4L8 20l-5 1 1-5z"/><path d="M14 6l4 4"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M9 2h6"/><path d="M12 2v3"/>',
  chart: '<path d="M3 21h18"/><path d="M7 17v-7"/><path d="M12 17V5"/><path d="M17 17v-4"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z"/>',
  snowflake: '<path d="M12 2v20"/><path d="m3.34 7 17.32 10"/><path d="m3.34 17 17.32-10"/><path d="m9 4 3 2 3-2"/><path d="m9 20 3-2 3 2"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  headphones: '<path d="M3 14v-3a9 9 0 0 1 18 0v3"/><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H3z"/><path d="M18 14h3v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z"/>',
  hash: '<path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="M16 3l-2 18"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  x: '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',
  warning: '<path d="m21.7 18.4-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-2.6z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  report: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
// filled — залитый вариант (закладка поставлена, флажок стоит)
const icon = (name, filled = false) => `<svg class="svg-ico" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
// статичные места из index.html (вкладки, серия, тема) заполняются при старте
const fillStaticIcons = () => document.querySelectorAll('[data-icon]').forEach(e => { e.innerHTML = icon(e.dataset.icon); });
fillStaticIcons(); // скрипт подключён в конце body — разметка уже есть

const BADGE_META = {
  first: ['🌱', 'Первый ответ', 'Первый шаг сделан'],
  'answers-100': ['💯', '100 ответов', 'Сотня позади'],
  'answers-500': ['🔥', '500 ответов', 'Пятьсот ответов'],
  'answers-1500': ['🏔', '1500 ответов', 'Полторы тысячи ответов'],
  'streak-3': ['📅', '3 дня подряд', 'Три дня без пропусков'],
  'streak-7': ['🗓', 'Неделя подряд', 'Семь дней без пропусков'],
  'streak-30': ['🏅', 'Месяц подряд', 'Тридцать дней без пропусков'],
  'gold-week': ['✨', 'Золотая неделя', 'Семь дней подряд с закрытой целью'],
  'exam-pass': ['🎓', 'Экзамен сдан', 'Первая пробная сдача'],
  'exam-strong': ['🏆', 'Все блоки 9+', 'Экзамен на 9 и выше в каждом блоке'],
  'learned-100': ['📗', '100 выучено', 'Сто вопросов на уровне 3+'],
  'learned-300': ['📘', '300 выучено', 'Половина банка'],
  'learned-all': ['📚', 'Весь банк', 'Все 600 вопросов выучены'],
  'no-weak': ['🎯', 'Без слабых тем', 'Точность 80%+ в каждом разделе'],
};
const badgeTitle = id => t(BADGE_META[id]?.[1] || id);

// Конфетти: 40–80 цветных прямоугольников падают полторы секунды. Только
// transform/opacity, без layout; при «уменьшить движение» не показываем.
function confetti(n = 60) {
  if (reducedMotion()) return;
  document.querySelector('.confetti')?.remove();
  const box = el('div', 'confetti');
  box.setAttribute('aria-hidden', 'true');
  const colors = ['#ff0000', '#ffffff', '#0b5c46', '#ffd166', '#4cc9f0', '#ff7ab6'];
  for (let i = 0; i < n; i++) {
    const p = el('i');
    p.style.cssText = `left:${(Math.random() * 100).toFixed(1)}%;background:${colors[i % colors.length]};`
      + `animation-delay:${Math.round(Math.random() * 350)}ms;animation-duration:${1300 + Math.round(Math.random() * 900)}ms;`
      + `--rot:${Math.round(Math.random() * 720)}deg;--sway:${Math.round(Math.random() * 80 - 40)}px`;
    box.append(p);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 2700);
}

// Поздравление при сдаче экзамена: на весь экран, по-грузински — буквы გილოცავ!
// появляются по одной, ниже «экзамен сдан» и перевод на язык интерфейса.
// Уходит по тапу, Escape или само через три секунды; конфетти сыплется поверх.
function cheer() {
  document.querySelector('.cheer')?.remove();
  const box = el('div', 'cheer');
  box.setAttribute('aria-hidden', 'true'); // заголовок экрана результата уже озвучен
  const word = el('div', 'cheer-word'); word.lang = 'ka';
  [...'გილოცავ!'].forEach((ch, i) => {
    const sp = el('span', null, ch);
    sp.style.animationDelay = `${150 + i * 70}ms`;
    word.append(sp);
  });
  const line = el('div', 'cheer-line', 'გამოცდა ჩაბარებულია'); line.lang = 'ka';
  box.append(word, line);
  if (I18N.lang !== 'ka') box.append(el('div', 'cheer-tr', t('Поздравляю! Экзамен сдан')));
  let gone = false;
  const close = () => {
    if (gone) return; gone = true;
    document.removeEventListener('keydown', onKey);
    box.classList.add('out');
    setTimeout(() => box.remove(), 350);
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  box.onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.append(box);
  setTimeout(close, reducedMotion() ? 2200 : 3400);
}

function markUnsure(q) {
  P.srs[qKey(q)] = D.unsureCard(card(q), today());
  save();
}
// «угадал» вернул карточку ниже, чем она была до ответа — в итоге занятия это не подъём
function undoUp(q) {
  const before = session?.boxBefore?.get(qKey(q));
  if (before != null && card(q).box <= before && session.up > 0) session.up--;
}

/* ------------------------------- вопросы ---------------------------------- */
let QUESTIONS = [];
const ALL_SUBJECTS = 'all';
const bySubject = s => s === ALL_SUBJECTS ? QUESTIONS : QUESTIONS.filter(q => q.subject === s);
const sectionsOf = s => [...new Set(bySubject(s).map(q => q.section))];

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const sample = (arr, n) => shuffled(arr).slice(0, n);

/* ------------------------------- состояние -------------------------------- */
let nav = 'home';
let session = null;   // {kind, queue, i, answers:Map, blocks?, ...}
const systemTheme = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const activeTheme = () => P.settings.theme === 'system' ? systemTheme() : P.settings.theme;

/* --------------------- персист сессий (учёба и экзамен) --------------------
   Сессия сохраняется после каждого ответа: звонок, сворачивание или смерть
   процесса больше не теряют идущий экзамен. */
let byKey = new Map(); // qKey -> вопрос, заполняется при загрузке банка

function persistSession() {
  if (!loaded) return; // ранний lifecycle-ивент не должен удалить ещё не восстановленную сессию
  if (!session || session.kind === 'quick' || (session.kind === 'exam' && session.finished)) { store.del(SESSION_KEY); return; }
  const s = session;
  const data = {
    kind: s.kind, i: s.i,
    unsureDone: [...(s.unsureDone || [])],
    order: s.orderCache ? [...s.orderCache] : [],
  };
  if (s.kind === 'study') {
    Object.assign(data, {
      subject: s.subject, section: s.section, mode: s.mode, right: s.right,
      queue: s.queue.map(qKey), answers: [...s.answers],
      up: s.up || 0, down: s.down || 0, sureWrong: s.sureWrong || 0, readyAt: s.readyAt ?? null, day: s.day || null,
    });
  } else {
    Object.assign(data, {
      b: s.b, startedAt: s.startedAt, between: !!s.between, seed: s.seed ?? null, code: s.code || null,
      flagged: [...(s.flagged || [])],
      blocks: s.blocks.map(b => ({ subject: b.subject, queue: b.queue.map(qKey), answers: [...b.answers], endsAt: b.endsAt, done: b.done })),
    });
  }
  store.set(SESSION_KEY, JSON.stringify(data));
}

function restoreSession() {
  let d;
  try { d = JSON.parse(store.get(SESSION_KEY) || 'null'); } catch { d = null; }
  if (!d) return;
  const revive = keys => (keys || []).map(k => byKey.get(k)).filter(Boolean);
  try {
    if (d.kind === 'study') {
      const queue = revive(d.queue);
      if (!queue.length || d.i >= queue.length) throw new Error('empty');
      // экзамен дня прошлого дня не восстанавливаем: попытка уже засчитана в тот день
      if (d.mode === 'daily' && d.day !== today()) throw new Error('stale daily');
      session = {
        kind: 'study', subject: d.subject, section: d.section === 'Основы права' ? 'all' : d.section, mode: d.mode, // право разбито на подтемы в 3.3
        queue, i: d.i, right: d.right || 0, answers: new Map(d.answers || []),
        up: d.up || 0, down: d.down || 0, sureWrong: d.sureWrong || 0, readyAt: Number.isFinite(d.readyAt) ? d.readyAt : null, day: d.day || null,
      };
    } else if (d.kind === 'exam') {
      const blocks = (d.blocks || []).map(b => ({
        subject: b.subject, queue: revive(b.queue),
        answers: new Map(b.answers || []), endsAt: b.endsAt, done: b.done,
      }));
      if (blocks.length === 0 || blocks.some(b => b.queue.length !== BLOCK_SIZE)) throw new Error('bank changed');
      session = { kind: 'exam', blocks, b: d.b || 0, i: d.i || 0, finished: false, startedAt: d.startedAt || Date.now(), between: !!d.between, seed: Number.isFinite(d.seed) ? d.seed : null, code: typeof d.code === 'string' ? d.code : null };
      if (d.flagged?.length) session.flagged = new Set(d.flagged);
    } else throw new Error('unknown kind');
    if (d.unsureDone?.length) session.unsureDone = new Set(d.unsureDone);
    if (d.order?.length) session.orderCache = new Map(d.order);
    nav = session.kind;
    if (session.kind === 'exam') {
      checkExamClock(); // блоки могли истечь, пока приложение было закрыто
      if (session && !session.finished) startTimer();
    }
    toast(t('Сессия восстановлена'));
  } catch { session = null; store.del(SESSION_KEY); }
}

const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const view = document.getElementById('view');
const pct = (a, b) => b ? Math.round(100 * a / b) : 0;

// Короткое объявление для TalkBack. Живая область одна на всё приложение:
// aria-live на контейнере экрана заставлял бы перечитывать его целиком
// после каждого нажатия.
const srRegion = document.getElementById('sr');
function announce(msg) {
  if (!srRegion) return;
  srRegion.textContent = '';
  setTimeout(() => { srRegion.textContent = msg; }, 50);
}

// Тосты показываются по очереди: цель дня, заморозка и достижение приходят
// в одном тике, и последний не должен затирать первые до отрисовки.
const toastQueue = [];
let toastBusy = false;
function toast(msg) {
  if (toastQueue.length < 4) toastQueue.push(msg);
  if (!toastBusy) nextToast();
}
function nextToast() {
  const msg = toastQueue.shift();
  if (msg == null) { toastBusy = false; return; }
  toastBusy = true;
  const toastEl = el('div', 'toast', esc(msg));
  // внутри landmark'а «Уведомления», а не прямо в body: скринридеры обходят страницу по landmark'ам
  (document.getElementById('toasts') || document.body).appendChild(toastEl);
  announce(msg); // всплывающие подсказки иначе не доходят до скринридера
  setTimeout(() => { toastEl.remove(); nextToast(); }, 2200);
}

// Свой диалог подтверждения: системный confirm() в WebView может быть подавлен и всегда возвращать false
function ask(message, okLabel = t('Да'), cancelLabel = t('Отмена')) {
  return new Promise(resolve => {
    document.querySelector('.modal-back')?.remove();
    const back = el('div', 'modal-back');
    const box = el('div', 'modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', t('Подтверждение'));
    box.append(el('p', 'modal-text', esc(message)));
    const row = el('div', 'modal-row');
    const no = el('button', 'btn ghost', cancelLabel);
    const yes = el('button', 'btn', okLabel);
    row.append(no, yes);
    box.append(row);
    back.append(box);
    // Фокус возвращаем туда, откуда открыли диалог: иначе после закрытия
    // TalkBack и клавиатура начинают обход с начала экрана.
    const opener = document.activeElement;
    const close = v => {
      back.remove();
      document.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus();
      resolve(v);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); return; }
      // Ловушка фокуса: Tab не должен уводить за пределы модального окна
      if (e.key === 'Tab') {
        e.preventDefault();
        const focusable = [no, yes];
        const i = focusable.indexOf(document.activeElement);
        const next = e.shiftKey ? i - 1 : i + 1;
        focusable[(next + focusable.length) % focusable.length].focus();
      }
    };
    no.onclick = () => close(false);
    yes.onclick = () => close(true);
    back.onclick = e => { if (e.target === back) close(false); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    yes.focus();
  });
}


/* Дату пользователю показываем словами: «25 августа», «25 августа 2027» —
   ISO-строка вида 2026-08-25 читается как техническое поле. Локаль берём
   системную, поэтому при переводе интерфейса формат подстроится сам. */
// Грузинские месяцы — на случай WebView с урезанным ICU, где ka-GE недоступна
// и Intl молча вернул бы системную локаль.
const KA_MONTHS = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];
const localeSupported = loc => { try { return Intl.DateTimeFormat.supportedLocalesOf([loc]).length > 0; } catch { return false; } };
const fmtDate = (iso, opts) => {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const sameYear = y === new Date().getFullYear();
  if (I18N.lang === 'ka' && !localeSupported('ka')) return `${d} ${KA_MONTHS[m - 1]}${sameYear ? '' : ` ${y}`}`;
  try {
    return new Intl.DateTimeFormat(I18N.locale, {
      day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }), ...opts,
    }).format(date);
  } catch { return iso; }
};
const fmtDateShort = iso => {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-').map(Number);
  try {
    return new Intl.DateTimeFormat(I18N.locale, { day: '2-digit', month: '2-digit' })
      .format(new Date(y, m - 1, d));
  } catch { return iso; }
};

/* ------------------------------ ONBOARDING -------------------------------- */
let onbStep = 0;

function finishOnboarding() {
  P.settings.onboarded = true;
  save();
  onbStep = 0;
  nav = 'home';
  render();
}

function screenOnboarding() {
  const wrap = el('div', 'view-inner onboarding');
  const steps = 4;

  const dots = el('div', 'dots');
  for (let i = 0; i < steps; i++) {
    const d = el('span', `dot${i === onbStep ? ' on' : ''}`);
    dots.append(d);
  }
  wrap.append(dots);

  const c = el('div', 'card');

  if (onbStep === 0) {
    // нулевой шаг — язык: заголовок на трёх языках, чтобы каждый нашёл свой
    c.append(el('h1', null, '<span lang="ru">Язык</span> · <span lang="uk">Мова</span> · <span lang="en">Language</span> · <span lang="ka">ენა</span>'));
    c.append(el('p', 'muted', t('Язык интерфейса можно сменить в настройках в любой момент.')));
    const seg = el('div', 'seg');
    I18N.langs.forEach(([id, label]) => {
      const b = el('button', null, label); b.lang = id; b.dataset.key = `lang:${id}`;
      b.setAttribute('aria-pressed', String(P.settings.uiLang === id));
      b.onclick = () => { P.settings.uiLang = id; if (id !== 'ka') P.settings.transLang = id; save(); applyUiLang(); render(); };
      seg.append(b);
    });
    c.append(seg);
    c.append(el('h2', 'h3', t('Зачем ты здесь?')));
    c.append(el('p', 'note', t('При восстановлении гражданства сдаётся только грузинский язык — история и право не понадобятся.')));
    const proc = el('div', 'seg');
    [['full', t('Обычная (три предмета)')], ['restore', t('Восстановление (только язык)')]].forEach(([id, label]) => {
      const b = el('button', null, label); b.dataset.key = `proc:${id}`;
      b.setAttribute('aria-pressed', String(P.settings.procedure === id));
      b.onclick = () => { P.settings.procedure = id; if (id === 'restore') P.settings.subject = 'language'; save(); render(); };
      proc.append(b);
    });
    c.append(proc);
  }

  if (onbStep === 1) {
    c.append(el('h1', null, t('Экзамен на гражданство')));
    c.append(el('p', 'muted', t('30 вопросов: по 10 на грузинский язык, историю Грузии и основы права. На каждый блок — 20 минут.')));
    const rule = el('div', 'verdict no');
    rule.textContent = t('Сдать нужно каждый блок: 7 правильных из 10. Отличный результат по истории не спасёт проваленный язык.');
    c.append(rule);
    c.append(el('p', 'muted', t('В приложении — те же 600 вопросов из официального банка, по которым составляют экзамен.')));

    c.append(el('h2', 'h3', t('Когда экзамен?')));
    c.append(el('p', 'note', t('Подберём дневную норму, чтобы успеть пройти всё. Можно пропустить и задать позже.')));
    const inp = el('input');
    inp.type = 'date';
    inp.setAttribute('aria-label', t('Дата экзамена'));
    inp.min = today();
    if (P.settings.examDate) inp.value = P.settings.examDate;
    inp.onchange = () => {
      P.settings.examDate = inp.value || null;
      if (inp.value) {
        const newLeft = QUESTIONS.filter(isNew).length;
        P.settings.newPerDay = D.planDailyNew(newLeft, inp.value, today(), P.settings.newPerDay);
      }
      save(); syncExamEve();
      render();
    };
    c.append(inp);
    if (P.settings.examDate) {
      const left = D.daysUntil(P.settings.examDate, today());
      c.append(el('p', 'note', left > 0
        ? t(`Осталось {0} {1} — это {2} {3} в день.`, [left, I18N.plural(left, ['день', 'дня', 'дней']), P.settings.newPerDay, I18N.plural(P.settings.newPerDay, ['новый вопрос', 'новых вопроса', 'новых вопросов'])])
        : t('Дата уже наступила — покажем всё, что успеем повторить.')));
    }
  }

  if (onbStep === 2) {
    c.append(el('h1', null, t('Повторение по интервалам')));
    c.append(el('p', 'muted', t('Приложение само решает, что показать сегодня. Ответил верно — вопрос вернётся позже; ошибся — вернётся завтра.')));
    const scale = el('div', 'boxes');
    BOX_INTERVALS.forEach((days, i) => {
      const b = el('div', 'box-step');
      b.append(el('b', null, String(i)));
      b.append(el('span', null, days === 0 ? t('сегодня') : t(`{0} дн.`, [days])));
      scale.append(b);
    });
    c.append(scale);
    c.append(el('p', 'note', t('Уровень растёт с каждым верным ответом. Вопрос считается выученным с уровня 3.')));
    const honest = el('div', 'why');
    honest.innerHTML = t('<b>Угадал?</b> Нажми «Угадал — повторить завтра». Случайно верный ответ не считается знанием — так на экзамене не будет сюрпризов.');
    c.append(honest);
  }

  if (onbStep === 3) {
    c.append(el('h1', null, t('Язык вопросов')));
    c.append(el('p', 'muted', t('На экзамене всё только по-грузински. Начни с двух языков и постепенно убирай перевод.')));
    const seg = el('div', 'seg');
    displayModes().forEach(([id, label]) => {
      const b = el('button', null, label);
      b.setAttribute('aria-pressed', String(P.settings.display === id));
      b.onclick = () => { P.settings.display = id; save(); render(); };
      seg.append(b);
    });
    c.append(seg);
    c.append(el('h2', 'h3', t('Новых вопросов в день')));
    const np = el('div', 'row');
    const inp = el('input');
    inp.type = 'number'; inp.min = 10; inp.max = 200; inp.value = P.settings.newPerDay; inp.style.width = '84px';
    inp.setAttribute('aria-label', t('Новых вопросов в день'));
    inp.onchange = () => {
      P.settings.newPerDay = Math.max(10, Math.min(200, +inp.value || 40));
      save(); render();
    };
    np.append(inp);
    const newLeft = QUESTIONS.filter(isNew).length;
    np.append(el('span', 'note', t(`всего непройденных: {0}`, [newLeft])));
    c.append(np);
    const finish = D.forecastFinishDate(newLeft, P.settings.newPerDay, today());
    c.append(el('p', 'note', t(`При такой норме пройдёшь весь банк к {0}.`, [fmtDate(finish)])));
  }

  wrap.append(c);

  const row = el('div', 'row');
  if (onbStep > 0) {
    const back = el('button', 'btn ghost', t('← Назад'));
    back.onclick = () => { onbStep--; render(); };
    row.append(back);
  }
  const next = el('button', 'btn', onbStep < steps - 1 ? t('Дальше →') : t('Начать подготовку'));
  next.onclick = () => { if (onbStep < steps - 1) { onbStep++; render(); } else finishOnboarding(); };
  row.append(next);
  const skip = el('button', 'btn ghost', t('Пропустить'));
  skip.onclick = finishOnboarding;
  row.append(skip);
  wrap.append(row);
  return wrap;
}

/* -------------------------- отображение вопроса ---------------------------- */
const fixBlanks = txt => String(txt).replace(/-{2,}/g, '\u00a0____\u00a0');

/* ------------------------- язык интерфейса и перевода ---------------------- */
const subjName = subj => I18N.lang === 'ka' ? subj.ka : (I18N.lang === 'en' && subj.en) ? subj.en : (I18N.lang === 'uk' && subj.uk) ? subj.uk : subj.ru;
// грузинская подпись рядом с названием предмета; в грузинском интерфейсе она дублировала бы название
const subjSub = subj => I18N.lang === 'ka' ? '' : subj.ka;
function applyUiLang() {
  I18N.setLang(P.settings.uiLang);
  document.documentElement.lang = I18N.lang;
  document.title = { en: 'მოქალაქეობა · Georgian citizenship trainer', ka: 'მოქალაქეობა · მოქალაქეობის ტრენაჟორი' }[I18N.lang]
    || 'მოქალაქეობა · Тренажёр на гражданство Грузии';
}

const hasEnglishBank = () => !!QUESTIONS[0]?.questionEn;
const hasUkBank = () => !!QUESTIONS[0]?.questionUk;
// язык перевода вопросов: русский — базовый, английский и украинский — если есть в банке;
// у конкретного вопроса нет перевода — показываем русский
const transLang = () => (P.settings.transLang === 'en' && hasEnglishBank()) ? 'en' : (P.settings.transLang === 'uk' && hasUkBank()) ? 'uk' : 'ru';
const TR_SUFFIX = { en: 'En', uk: 'Uk' };
const trField = (q, base, ruField) => { const sfx = TR_SUFFIX[transLang()]; return (sfx && q[base + sfx]) || q[ruField]; };
const trQuestion = q => trField(q, 'question', 'questionRu');
const trOptions = q => trField(q, 'options', 'optionsRu');
const trSection = q => I18N.lang === 'ka' && q.sectionKa ? q.sectionKa : trField(q, 'section', 'section');
const trExplanation = q => trField(q, 'explanation', 'explanation');

// Режимы показа: ka_ru — грузинский главным, перевод под ним; ru — перевод
// главным, грузинский под ним; ka — только грузинский. Ключ 'ru' сохранён
// для совместимости с прогрессом прошлых версий.
let peekKey = null; // вопрос, для которого в режиме «только KA» подсмотрели перевод
let noteOpen = null; // вопрос, у которого открыт редактор заметки
let noteDraft = null; // несохранённый текст редактора — переживает перерисовку на месте
const closeNote = () => { noteOpen = null; noteDraft = null; };
// В языковом блоке «перевод» варианта часто совпадает с оригиналом (86 вопросов
// из 200): переводить там нечего. Одинаковый текст второй раз не показываем.
const sameText = (a, b) => a != null && b != null
  && String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim();
function texts(q, display = P.settings.display) {
  const d = display;
  const trSub = d === 'ka_ru' || (d === 'ka' && peekKey === qKey(q)), kaSub = d === 'ru';
  const main = fixBlanks(d === 'ru' ? trQuestion(q) : q.questionKa);
  const subRaw = trSub ? fixBlanks(trQuestion(q)) : kaSub ? fixBlanks(q.questionKa) : null;
  const hasTr = !sameText(trQuestion(q), q.questionKa) || q.optionsKa.some((ka, i) => !sameText(trOptions(q)[i], ka));
  return {
    main, mainKa: d !== 'ru',
    sub: sameText(subRaw, main) ? null : subRaw,
    subKa: kaSub, hasTr,
    opts: q.optionsKa.map((ka, i) => {
      const m = d === 'ru' ? trOptions(q)[i] : ka;
      const sub = trSub ? trOptions(q)[i] : kaSub ? ka : null;
      const dup = sameText(sub, m);
      return { main: m, mainKa: d !== 'ru' || (dup && kaSub), sub: dup ? null : sub, subKa: kaSub, index: i };
    }),
  };
}
// подписи режимов: перевод обозначаем языком перевода (RU/EN)
const displayModes = () => {
  const tl = ({ uk: 'UA' })[transLang()] || transLang().toUpperCase();
  return [['ka_ru', `KA + ${tl}`], ['ru', `${tl} + KA`], ['ka', t('Только KA')]];
};
function speak(text) {
  // в Capacitor-сборке озвучка идёт через плагин GeorgianTts
  const capTts = window.Capacitor?.Plugins?.GeorgianTts;
  if (capTts) {
    capTts.available()
      .then(r => {
        if (!r.value) return toast(t('Нет грузинского голоса — установи его в настройках синтеза речи'));
        capTts.speak({ text, rate: P.settings.ttsRate || 0.85 });
      })
      .catch(() => toast(t('Озвучка недоступна')));
    return;
  }
  // старая обёртка v2.2: синхронный JS-мост
  try {
    if (window.AndroidTTS) {
      if (!window.AndroidTTS.available()) return toast(t('Нет грузинского голоса — установи его в настройках синтеза речи'));
      window.AndroidTTS.speak(text);
      return;
    }
  } catch { /* пробуем браузерный синтез */ }
  // iOS и браузер: Web Speech API. Без грузинского голоса система прочитала бы
  // текст английским голосом — бессмыслица, поэтому сначала ищем голос ka.
  if (!window.speechSynthesis) return toast(t('Озвучка недоступна'));
  const voice = speechSynthesis.getVoices().find(v => /^ka\b/i.test(v.lang));
  if (!voice) return toast(t('Нет грузинского голоса — установи его в настройках синтеза речи'));
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice; u.lang = voice.lang; u.rate = P.settings.ttsRate || 0.85;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}

/* ================================ ЭКРАНЫ ================================== */

function screenHome() {
  const wrap = el('div', 'view-inner');
  wrap.append(el('h1', 'sr-only', t('Обзор подготовки')));

  if (lastSummary) {
    const S = lastSummary;
    const c = el('div', 'card summary');
    c.append(el('h2', 'h3', S.mode === 'daily' ? `${t('Экзамен дня')} · ${fmtDate(today())}` : `${t('Итог занятия')} · ${S.subject === ALL_SUBJECTS ? t('Все предметы') : subjName(SUBJ[S.subject])}`));
    const acc = pct(S.right, S.answered);
    c.append(el('div', 'verdict ' + (acc >= 70 ? 'ok' : 'no'), t('{0} из {1} верно · {2}%', [S.right, S.answered, acc])));
    // плитки как в «плане на сегодня»: число крупно, подпись под ним
    const m = el('div', 'grid3');
    const tile = (v, label) => m.append(el('div', 'metric', `<b>${v}</b><span>${label}</span>`));
    tile(`▲ ${S.up}`, t('поднялись на уровень'));
    tile(`↺ ${S.down}`, t('вернулись в начало'));
    if (S.sureWrong) tile(`! ${S.sureWrong}`, t('уверенных ошибок'));
    tile(S.dueTomorrow, t('завтра к повтору'));
    c.append(m);
    if (Number.isFinite(S.before)) {
      const d = S.after - S.before;
      c.append(el('p', 'note', t('Прогноз по предмету: {0} → {1}', [S.before.toFixed(1), S.after.toFixed(1)]) + (Math.abs(d) >= 0.05 ? ` (${d > 0 ? '+' : ''}${d.toFixed(1)})` : '')));
    }
    const rowB = el('div', 'row actions-grid');
    if (S.mode === 'daily') {
      const sh = el('button', 'btn', `${icon('share')} ${t('Поделиться')}`);
      sh.onclick = () => shareText(t('Экзамен дня {0}: {1} из 9 — тренажёр на гражданство Грузии (მოქალაქეობა). А у тебя?', [fmtDate(today()), S.right]));
      rowB.append(sh);
    } else {
      const again = el('button', 'btn', t('Ещё занятие'));
      again.onclick = () => { lastSummary = null; if (!startStudy(S.subject, S.section, (S.mode === 'search' || S.mode === 'rule') ? 'plan' : S.mode)) render(); };
      rowB.append(again);
    }
    const close = el('button', 'btn ghost', t('Закрыть'));
    close.onclick = () => { lastSummary = null; render(); };
    rowB.append(close);
    c.append(rowB);
    wrap.append(c);
  }

  // первая неделя: три шага вместо панели нулей — 10 вопросов, пробный блок, дата
  const fresh = P.stats.answered === 0 && P.exams.length === 0;
  const week1 = [
    { id: 'ten', done: P.stats.answered >= 10, label: t('Ответить на 10 вопросов'), hint: t('тренажёр запомнит, что даётся тяжело'), go: () => startStudy(P.settings.subject, 'all', 'plan', 10) },
    { id: 'block', done: P.exams.length >= 1, label: t('Пройти пробный блок'), hint: t('10 вопросов, 20 минут — как на экзамене'), go: () => startExam([goalSubjects()[0].id]) },
    { id: 'date', done: !!P.settings.examDate, label: t('Задать дату экзамена'), hint: t('план дня подстроится под неё'), go: () => { nav = 'settings'; render(); } },
  ];

  /* ---- «Сегодня»: одно главное действие наверху экрана ---- */
  const subj = P.settings.subject;
  const queueN = pickQueue(subj, 'all', 'plan').length;
  const subjQs = bySubject(subj);
  const dueS = subjQs.filter(q => card(q).seen > 0 && isDue(q)).length;
  const newS = Math.min(subjQs.filter(isNew).length, P.settings.newPerDay);
  const leechS = subjQs.filter(isLeech).length;
  const hero = el('section', 'card hero');
  const top = el('div', 'hero-top');
  top.append(el('span', 'hero-date', `${t('Сегодня')}, ${fmtDate(today())}`));
  if (P.settings.examDate) {
    const left = D.daysUntil(P.settings.examDate, today());
    if (left >= 0) top.append(el('span', 'tag', left === 0 ? t('Экзамен сегодня. Удачи!') : t('до экзамена {0} {1}', [left, I18N.plural(left, ['день', 'дня', 'дней'])])));
  }
  hero.append(top);
  // крупное число — главное на экране; подпись и разбивка мельче
  const goal = dailyGoal(), done = doneToday(), ratio = Math.min(1, done / goal);
  const headRow = el('div', 'hero-head');
  if (queueN) {
    headRow.append(el('div', 'hero-num', String(queueN)));
    headRow.append(el('div', 'hero-lbl', `<b>${I18N.plural(queueN, ['вопрос', 'вопроса', 'вопросов'])} ${t('на сегодня')}</b><span>≈ ${Math.max(1, Math.round(queueN * 0.4))} ${t('мин')} · ${t('повторить {0} · новых {1} · проблемных {2}', [dueS, newS, leechS])}</span>`));
  } else {
    headRow.append(el('div', 'hero-lbl', `<b class="hero-done">${t('На сегодня всё')}</b><span>${t('Новые вопросы закончились — повтори ошибки или пройди пробный экзамен.')}</span>`));
  }
  hero.append(headRow);
  // цель дня — ряд из десяти кружков, как в бланке ответов экзамена
  const filled = Math.round(ratio * 10);
  const gl = el('div', 'goal-sheet');
  gl.setAttribute('role', 'img');
  gl.setAttribute('aria-label', `${t('Цель дня')}: ${t('{0} из {1} · осталось {2}', [done, goal, Math.max(0, goal - done)])}`);
  gl.innerHTML = `<span class="bubbles" aria-hidden="true">${Array.from({ length: 10 }, (_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('')}</span><span class="goal-cap">${t('Цель дня')} <b>${done}/${goal}</b></span>`;
  hero.append(gl);
  // предмет — переключатель, а не три кнопки «начать»: старт один
  const seg = el('div', 'tabs-line');
  SUBJECTS.forEach(sx => {
    const b = el('button', null, subjName(sx));
    b.setAttribute('aria-pressed', String(sx.id === subj));
    b.onclick = () => { P.settings.subject = sx.id; save(); renderInPlace(); };
    seg.append(b);
  });
  hero.append(seg);
  const start = el('button', 'btn block hero-cta', queueN ? t('Начать занятие') : t('Пробный экзамен'));
  start.onclick = () => { if (queueN) startStudy(subj, 'all', 'plan'); else { nav = 'exam'; render(); } };
  hero.append(start);
  // серия — одной строкой
  const streak = liveStreak(), fz = P.stats.freezes || 0;
  const sl = el('div', 'streak-line');
  sl.append(el('span', null, `${icon('flame')} ${t('Серия {0} {1}', [streak, I18N.plural(streak, ['день', 'дня', 'дней'])])}`));
  sl.append(el('span', null, `${icon('snowflake')} ${fz} ${I18N.plural(fz, ['заморозка', 'заморозки', 'заморозок'])}`));
  if (D.isGoldWeek(P.stats, today())) sl.append(el('span', 'gold', `${icon('sparkles')} ${t('золотая неделя')}`));
  sl.title = t('Закрытая цель дня даёт заморозку (до двух): пропущенный день не обрывает серию.');
  hero.append(sl);
  if (P.stats.lostStreak && P.stats.lostOn && dayNum(today()) - dayNum(P.stats.lostOn) <= D.EARNBACK_DAYS) {
    const need = 2 * goal;
    hero.append(el('div', 'verdict no', t('Серия {0} {1} оборвалась {2}. Закрой сегодня двойную норму — {3} {4} ({5} уже есть) — и она вернётся.',
      [P.stats.lostStreak, I18N.plural(P.stats.lostStreak, ['день', 'дня', 'дней']), fmtDate(P.stats.lostOn), need, I18N.plural(need, ['ответ', 'ответа', 'ответов']), done])));
  }
  if (D.isFinalStretch(P.settings.examDate, today())) hero.append(el('div', 'verdict ok', t('Финальная прямая: новых вопросов нет — повторяем ошибки и просроченное. Накануне — только повторение и сон.')));
  if (P.settings.examDate) {
    const left = D.daysUntil(P.settings.examDate, today());
    const newLeft = QUESTIONS.filter(isNew).length;
    const finish = D.forecastFinishDate(newLeft, P.settings.newPerDay, today());
    if (left < 0) hero.append(el('div', 'verdict', t(`Экзамен был {0}. Задай новую дату в настройках.`, [fmtDate(P.settings.examDate)])));
    else if (left > 0 && dayNum(finish) > dayNum(P.settings.examDate)) hero.append(el('div', 'verdict no', t(`До экзамена {0} {1}, а весь банк закончится только к {2}. Подними норму до {3} в день.`, [left, I18N.plural(left, ['день', 'дня', 'дней']), fmtDate(finish), D.planDailyNew(newLeft, P.settings.examDate, today(), P.settings.newPerDay)])));
  }
  wrap.append(hero);

  if (P.stats.answered < 50 && week1.some(x => !x.done)) {
    const w = el('div', 'card');
    w.append(el('h2', 'h3', t('Неделя 1')));
    const ul = el('ul', 'week1'); ul.setAttribute('role', 'list');
    week1.forEach(x => {
      const li = el('li', x.done ? 'done' : '');
      const b = el('button', 'week1-row', `<span class="tick" aria-hidden="true">${icon(x.done ? 'check' : 'circle')}</span><span class="txt"><b>${x.label}</b><span class="note">${x.hint}</span></span>`);
      b.disabled = x.done; b.onclick = x.go;
      if (x.done) b.setAttribute('aria-label', `${x.label} — ${t('сделано')}`);
      li.append(b); ul.append(li);
    });
    w.append(ul);
    wrap.append(w);
  }

  /* ---- готовность: одна строка на предмет, балл крупно ---- */
  const ready = el('section', 'card');
  ready.append(el('h2', 'h3', t('Готовность к экзамену')));
  const rl = el('ul', 'ready-list'); rl.setAttribute('role', 'list');
  goalSubjects().forEach(sx => {
    const qs = bySubject(sx.id);
    const known = qs.filter(q => card(q).box >= D.KNOWN_BOX).length;
    const forecast = D.readiness(qs.map(card), qs.length);
    const state = D.readinessState(forecast);
    const stateLabel = { likely: t('скорее сдашь'), coin: t('50 на 50'), early: t('рано') }[state];
    const need = D.toLearnFor(qs.map(card), qs.length);
    const li = el('li', `ready-row ${state}`);
    li.innerHTML = `<div class="rr-top"><span class="rr-name"><b>${subjName(sx)}</b> <span class="muted ka" lang="ka">${subjSub(sx)}</span></span>
      <span class="rr-score"><b>${forecast.toFixed(1)}</b><span>/10</span></span></div>
      <div class="bar ${state === 'likely' ? '' : state === 'coin' ? 'warn' : 'danger'}"><i style="width:${Math.min(100, known / qs.length * 100)}%"></i></div>
      <div class="rr-meta"><span class="badge ${state === 'likely' ? 'ok' : state === 'coin' ? 'warn' : 'no'}">${stateLabel}</span><span class="note">${need > 0 ? t('До уверенной сдачи — выучить ещё {0} {1}', [need, I18N.plural(need, ['вопрос', 'вопроса', 'вопросов'])]) : t('выучено {0} из {1}', [known, qs.length])}</span></div>`;
    rl.append(li);
  });
  ready.append(rl);
  {
    const scores = goalSubjects().map(sx => subjReady(sx.id));
    ready.append(el('p', 'note chance', t('Шанс сдать все блоки на настоящем экзамене: ~{0}% — оценка модели по твоему прогрессу, не статистика сдач.', [Math.round(D.passChance(scores) * 100)])));
  }
  const how = el('details', 'explain');
  how.innerHTML = `<summary>${t('Как считается прогноз')}</summary>`;
  how.append(el('p', 'note', t('Прогноз — ожидаемый балл из 10: выученные вопросы (уровень 3+) почти гарантированы, начатые считаются по твоей точности, новые — как угадывание из четырёх. «Скорее сдашь» — прогноз 8 и выше, «50 на 50» — от 6,5; порог экзамена — 7 из 10 в каждом блоке.')));
  ready.append(how);
  const stLink = el('button', 'link-btn', `${t('Статистика по разделам')} ${icon('chevron')}`);
  stLink.onclick = () => { nav = 'stats'; render(); };
  ready.append(stLink);
  if (!fresh) wrap.append(ready);

  // «Мой путь»: где человек в процедуре — одна строка-кнопка
  {
    const steps = pathSteps();
    const doneN = steps.filter(st => P.path.done[st.id]).length;
    const cur = steps.find(st => !P.path.done[st.id]);
    const pc = el('button', 'card path-card path-row');
    pc.innerHTML = `<span class="mode-ico" aria-hidden="true">${icon('compass')}</span>
      <span class="mode-body"><b>${t('Мой путь')}</b><span class="note">${esc(cur ? t('Шаг {0} из {1}: {2}', [doneN + 1, steps.length, cur.title]) : t('Все шаги отмечены — поздравляем!'))}</span>
      <span class="bar"><i style="width:${Math.round(doneN / steps.length * 100)}%"></i></span></span>
      <span class="mode-chevron" aria-hidden="true">${icon('chevron')}</span>`;
    pc.onclick = () => { backNav = 'home'; nav = 'path'; render(); };
    wrap.append(pc);
  }

  /* ---- активность и итоги: одна карточка ---- */
  const hist = P.stats.history || {};
  const days = Array.from({ length: 30 }, (_, i) => D.addDays(today(), i - 29));
  const counts = days.map(d => hist[d] || 0);
  const max = Math.max(1, ...counts);
  const total = counts.reduce((x, y) => x + y, 0), active = counts.filter(Boolean).length;
  const actCard = el('section', 'card');
  actCard.append(el('h2', 'h3', t('Активность')));
  const act = el('div', 'activity');
  act.setAttribute('role', 'img');
  act.setAttribute('aria-label', t('Активность за 30 дней: {0} {1}, {2} {3} с занятиями', [total, I18N.plural(total, ['ответ', 'ответа', 'ответов']), active, I18N.plural(active, ['день', 'дня', 'дней'])]));
  act.innerHTML = `<div class="bars">${counts.map((n, i) => `<i style="height:${Math.max(n ? 8 : 3, Math.round(n / max * 100))}%"${i === 29 ? ' class="today"' : ''} title="${days[i]}: ${n}"></i>`).join('')}</div>
    <span class="note">${t('30 дней · {0} {1} · {2} {3} с занятиями', [total, I18N.plural(total, ['ответ', 'ответа', 'ответов']), active, I18N.plural(active, ['день', 'дня', 'дней'])])}</span>`;
  const week = counts.slice(-7).reduce((x, y) => x + y, 0), prev = counts.slice(-14, -7).reduce((x, y) => x + y, 0);
  if (week || prev) act.append(el('span', 'note', t('Эта неделя: {0} {1} · прошлая: {2}', [week, I18N.plural(week, ['ответ', 'ответа', 'ответов']), prev]) + (week > prev && prev ? ' ↑' : week < prev ? ' ↓' : '')));
  actCard.append(act);
  const g = el('div', 'grid2');
  g.append(el('div', 'metric', t(`<b>{0}</b><span>ответов</span>`, [P.stats.answered])));
  g.append(el('div', 'metric', t(`<b>{0}</b><span>точность</span>`, [P.stats.answered ? `${pct(P.stats.correct, P.stats.answered)}%` : '—'])));
  g.append(el('div', 'metric', t(`<b>{0}/{1}</b><span>экзаменов сдано</span>`, [P.stats.examsPassed, P.stats.examsTaken])));
  g.append(el('div', 'metric', t(`<b>{0} / {1}</b><span>серия / рекорд</span>`, [liveStreak(), P.stats.bestStreak])));
  actCard.append(g);
  if (!fresh) wrap.append(actCard);

  // что просят сделать следующим: дешёвая проверка спроса до разработки
  const ideas = el('div', 'card');
  ideas.append(el('h2', 'h3', t('Что сделать следующим?')));
  ideas.append(el('p', 'muted', t('Нажми, что нужно тебе — так решаем, что делать дальше.')));
  const votes = el('div', 'votes');
  [['interview', 'mic', t('Репетиция собеседования с комиссией')], ['audio', 'headphones', t('Аудиокурс: слушать вопросы в дороге')]].forEach(([id, ico, label]) => {
    const on = !!P.stats.votes[id];
    const b = el('button', 'vote' + (on ? ' on' : ''), `<span class="vico" aria-hidden="true">${icon(ico)}</span><span>${label}</span><span class="tick" aria-hidden="true">${icon(on ? 'check' : 'plus')}</span>`);
    b.setAttribute('aria-pressed', String(on)); b.dataset.key = `vote:${id}`;
    b.onclick = () => {
      if (P.stats.votes[id]) delete P.stats.votes[id];
      else { P.stats.votes[id] = 1; toast(t('Записал — чем больше голосов, тем раньше сделаем')); }
      save(); render();
    };
    votes.append(b);
  });
  ideas.append(votes);
  wrap.append(ideas);

  if (!store.ok) wrap.append(el('p', 'note', t('⚠️ Браузер блокирует локальное хранилище в этом окне — прогресс живёт только до перезагрузки. В настройках можно выгрузить его в файл.')));
  return wrap;
}

/* ------------------------------- УЧИТЬ ------------------------------------ */
function screenStudy() {
  if (session && session.kind === 'study') return renderRunner();
  if (session && session.kind === 'quick') return renderQuick();

  const wrap = el('div', 'view-inner');
  wrap.append(el('h1', null, t('Учить')));
  const s = P.settings.subject;

  const c = el('div', 'card');
  c.append(el('h2', 'h3', t('Предмет')));
  const segS = el('div', 'seg');
  SUBJECTS.forEach(x => {
    const b = el('button', null, subjName(x));
    b.setAttribute('aria-pressed', String(x.id === s));
    b.onclick = () => { P.settings.subject = x.id; save(); render(); };
    segS.append(b);
  });
  c.append(segS);
  if (s === 'law') {
    // право — блок цифр и сроков: возрасты, сроки, кворумы из ключей агентства
    const nb = el('button', 'btn ghost small', `${icon('hash')} ${t('Цифры и сроки')}`);
    nb.onclick = () => { backNav = 'study'; nav = 'numbers'; render(); };
    c.append(nb);
  }
  if (s === 'language' && RULES.length) {
    // язык — свод правил к грамматическим вопросам: таблица форм + тренировка по правилу
    const gb = el('button', 'btn ghost small', `${icon('book')} ${t('Грамматика: правила')}`);
    gb.onclick = () => { backNav = 'study'; nav = 'grammar'; render(); };
    c.append(gb);
  }

  if (s !== 'language' && !isRestore() && bySubject('language').filter(q => card(q).seen > 0).length < 10) {
    c.append(el('p', 'note', t('Начни с языка: его нельзя выучить ответами — 10 вопросов берутся из 200, а на экзамене всё по-грузински.')));
  }
  c.append(el('h2', 'h3', t('Раздел')));
  const sel = el('select');
  sel.setAttribute('aria-label', t('Раздел предмета'));
  sel.append(el('option', null, t('Все разделы'))); sel.firstChild.value = 'all';
  sectionsOf(s).forEach(sec => {
    const o = el('option', null, esc(trSection(bySubject(s).find(q => q.section === sec))));
    o.value = sec; sel.append(o);
  });
  sel.value = session?.section || 'all';
  c.append(sel);
  wrap.append(c);

  // поиск по всем 600 вопросам на любом языке — найти конкретный вопрос после
  // экзамена или разговора и сразу его открыть
  const sc = el('div', 'card');
  const inp = el('input'); inp.type = 'search'; inp.placeholder = t('Найти вопрос…'); inp.value = searchQuery;
  inp.setAttribute('aria-label', t('Поиск по вопросам')); inp.autocomplete = 'off';
  const res = el('ul', 'rows search-results'); res.setAttribute('role', 'list');
  const run = () => {
    searchQuery = inp.value;
    res.replaceChildren();
    const found = searchQuestions(searchQuery);
    if (found && !found.length) res.append(el('li', 'muted', t('Ничего не найдено')));
    (found || []).forEach(q => {
      const li = el('li');
      const b = el('button', 'link-btn name', `${esc(trQuestion(q).slice(0, 90))}${trQuestion(q).length > 90 ? '…' : ''}`);
      b.onclick = () => openQuestion(q);
      li.append(b, el('span', 'vals', `<span class="v">${esc(subjName(SUBJ[q.subject]))} · ${esc(trSection(q))} · №${q.id}</span>`));
      res.append(li);
    });
  };
  let tmr = null;
  inp.oninput = () => { clearTimeout(tmr); tmr = setTimeout(run, 150); };
  sc.append(inp, res);
  wrap.append(sc);
  if (searchQuery.trim().length >= 2) run();

  // быстрый раунд: минута, два варианта, счёт — крючок на каждый день
  const qc = el('div', 'card');
  const qb = el('button', 'btn ghost block', `${icon('zap')} ${t('Быстрый раунд · 60 секунд')}`);
  qb.onclick = () => startQuick(s);
  qc.append(qb);
  qc.append(el('p', 'note', t('Выбери верный из двух, пока идёт минута. Лучший результат: {0}', [P.stats.quickBest || 0])));
  wrap.append(qc);

  const qs = bySubject(s);
  const counts = {
    plan: qs.filter(q => isDue(q)).length,
    mistakes: qs.filter(q => card(q).wrong > 0).length,
    leech: qs.filter(isLeech).length,
    starred: qs.filter(q => P.starred.includes(qKey(q))).length,
    all: qs.length,
  };
  const modes = [
    ['plan', 'play', t('По плану'), t('просроченные + новые')],
    ['mistakes', 'x', t('Ошибки'), t('где хоть раз ошибся')],
    ['leech', 'warning', t('Проблемные'), t(`{0}+ ошибок`, [LEECH_AT])],
    ['starred', 'star', t('Закладки'), t('сохранённые вопросы')],
    ['all', 'list', t('Все вопросы'), t('подряд, без фильтра')],
  ];
  // Один список тапабельных строк вместо пяти одинаковых карточек с пятью
  // кнопками «Начать»: режим — это и есть кнопка.
  const list = el('div', 'card mode-list');
  modes.forEach(([id, ico, title, hint]) => {
    const row = el('button', 'mode-row');
    row.disabled = counts[id] === 0;
    row.innerHTML = `
      <span class="mode-ico" aria-hidden="true">${icon(ico)}</span>
      <span class="mode-body"><b>${title}</b><span class="note">${hint}</span></span>
      <span class="mode-count">${counts[id]}</span>
      <span class="mode-chevron" aria-hidden="true">${icon('chevron')}</span>`;
    row.onclick = () => startStudy(s, sel.value, id);
    list.append(row);
  });
  wrap.append(list);
  return wrap;
}

/* ---------------------------- БЫСТРЫЙ РАУНД ------------------------------- */
// Минута на время: верный вариант против «с чем путают» (или случайного).
// Верный ответ идёт в статистику и цель дня, но уровень карточки не поднимает
// (угадать из двух слишком легко); ошибка — обычная ошибка.
const QUICK_SECONDS = 60;
let quickTimer = null;
function startQuick(subject) {
  peekKey = null; closeNote();
  const qs = bySubject(subject);
  const queue = shuffled(qs.filter(q => card(q).seen > 0)).concat(shuffled(qs.filter(isNew)));
  if (!queue.length) return;
  clearInterval(quickTimer);
  session = { kind: 'quick', subject, queue, i: 0, right: 0, wrong: 0, finished: false, endsAt: Date.now() + QUICK_SECONDS * 1000, pair: null, flash: null };
  nav = 'study';
  render();
  const sn = session;
  quickTimer = setInterval(() => {
    if (session !== sn || sn.finished) { clearInterval(quickTimer); return; }
    const left = Math.max(0, session.endsAt - Date.now());
    const bar = document.querySelector('.quick-timer i');
    if (bar) bar.style.width = `${(left / (QUICK_SECONDS * 1000) * 100).toFixed(1)}%`;
    const num = document.querySelector('.quick-left');
    if (num) num.textContent = Math.ceil(left / 1000);
    if (left <= 0) finishQuick();
  }, 200);
}
function quickPair(q) {
  const conf = D.confusedWith(card(q));
  const others = [0, 1, 2, 3].filter(i => i !== q.correct && i < q.optionsKa.length);
  const wrong = conf != null && conf !== q.correct && conf < q.optionsKa.length ? conf : others[Math.floor(Math.random() * others.length)];
  return shuffled([q.correct, wrong]);
}
function quickAnswer(oi) {
  if (!session || session.kind !== 'quick' || session.finished || session.flash) return;
  const sn = session;
  const q = session.queue[session.i];
  const ok = oi === q.correct;
  session.flash = ok ? 'ok' : 'no';
  announce(ok ? t('Верно') : t(`Неверно. Правильный ответ: {0}`, [trOptions(q)[q.correct]]));
  if (ok) {
    session.right++;
    P.stats.answered++; P.stats.correct++; touchDay(); bumpToday(); save();
  } else {
    session.wrong++;
    grade(q, false, { chosen: oi });
  }
  haptic(ok ? 'ok' : 'error');
  renderInPlace();
  setTimeout(() => {
    if (session !== sn || sn.finished) return; // раунд уже другой или закончился
    sn.i++; sn.pair = null; sn.flash = null;
    if (sn.i >= sn.queue.length) { finishQuick(); return; }
    renderInPlace();
    // клавиатура и скринридер: фокус на первый вариант новой пары, а не в никуда
    requestAnimationFrame(() => document.querySelector('.opts .opt')?.focus({ preventScroll: true }));
  }, ok ? 350 : 900);
}
function finishQuick() {
  clearInterval(quickTimer);
  if (!session || session.kind !== 'quick' || session.finished) return;
  session.finished = true;
  const best = P.stats.quickBest || 0;
  session.record = session.right > best;
  if (session.record) { P.stats.quickBest = session.right; save(); }
  if (nav === 'study') { render(); if (session.record && session.right > 0) setTimeout(() => confetti(40), 300); }
  else session = null; // ушли с экрана — результат никому не нужен, «сессия» не должна блокировать ярлыки и уведомления
}
function renderQuick() {
  const wrap = el('div', 'view-inner');
  const sn = session;
  if (sn.finished) {
    wrap.append(el('h1', null, t('Быстрый раунд')));
    const c = el('div', 'card');
    c.append(el('div', 'verdict ok', t('⚡ {0} {1} за {2} секунд', [sn.right, I18N.plural(sn.right, ['верный ответ', 'верных ответа', 'верных ответов']), QUICK_SECONDS])));
    const m = el('div', 'grid3');
    m.append(el('div', 'metric', `<b>${sn.right}</b><span>${t('верно')}</span>`));
    m.append(el('div', 'metric', `<b>${sn.wrong}</b><span>${t('ошибок')}</span>`));
    m.append(el('div', 'metric', `<b>${P.stats.quickBest || 0}</b><span>${t('рекорд')}</span>`));
    c.append(m);
    if (sn.record && sn.right > 0) c.append(el('p', 'note recipe', t('Новый рекорд!')));
    const row = el('div', 'row actions-grid');
    const again = el('button', 'btn', t('Ещё раз'));
    again.onclick = () => startQuick(sn.subject);
    const close = el('button', 'btn ghost', t('Закрыть'));
    close.onclick = () => { session = null; render(); };
    row.append(again, close);
    c.append(row);
    wrap.append(c);
    return wrap;
  }
  const q = sn.queue[sn.i];
  const tx = texts(q);
  const head = el('div', 'card quick-head');
  const left = Math.max(0, sn.endsAt - Date.now());
  head.append(el('div', 'spread', `<b>⚡ ${t('Быстрый раунд')} · ${subjName(SUBJ[sn.subject])}</b><span class="quick-score"><span class="quick-left" role="timer" aria-label="${t('Осталось секунд')}">${Math.ceil(left / 1000)}</span> ${t('сек')} · <span class="badge ok">${sn.right}</span></span>`));
  const timer = el('div', 'quick-timer'); timer.setAttribute('aria-hidden', 'true');
  timer.innerHTML = `<i style="width:${(left / (QUICK_SECONDS * 1000) * 100).toFixed(1)}%"></i>`;
  head.append(timer);
  wrap.append(head);
  const c = el('div', 'card');
  const qEl = el('div', `qtext ${tx.mainKa ? 'ka' : ''}`, esc(tx.main)); if (tx.mainKa) qEl.lang = 'ka';
  c.append(qEl);
  if (tx.sub) { const subEl = el('div', 'qtrans' + (tx.subKa ? ' ka' : ''), esc(tx.sub)); if (tx.subKa) subEl.lang = 'ka'; c.append(subEl); }
  sn.pair ||= quickPair(q);
  const opts = el('div', 'opts');
  sn.pair.forEach((oi, pos) => {
    const o = tx.opts[oi];
    const b = el('button', 'opt');
    if (sn.flash) { if (oi === q.correct) b.classList.add('correct'); else if (sn.flash === 'no') b.classList.add('wrong'); b.setAttribute('aria-disabled', 'true'); }
    b.append(el('span', 'key', String.fromCharCode(65 + pos)));
    const body = el('span', 'body');
    const main = el('span', o.mainKa ? 'ka' : '', esc(o.main)); if (o.mainKa) main.lang = 'ka';
    body.append(main);
    if (o.sub) { const se = el('span', 'sub' + (o.subKa ? ' ka' : ''), esc(o.sub)); if (o.subKa) se.lang = 'ka'; body.append(se); }
    b.append(body);
    b.onclick = () => quickAnswer(oi);
    opts.append(b);
  });
  c.append(opts);
  wrap.append(c);
  const stop = el('button', 'btn ghost block', t('Прервать'));
  stop.onclick = () => { clearInterval(quickTimer); session = null; render(); };
  wrap.append(stop);
  return wrap;
}

function pickQueue(subject, section, mode) {
  let qs = bySubject(subject);
  if (section && section !== 'all') qs = qs.filter(q => q.section === section);
  if (mode === 'mistakes') return shuffled(qs.filter(q => card(q).wrong > 0));
  if (mode === 'leech') return shuffled(qs.filter(isLeech));
  if (mode === 'starred') return shuffled(qs.filter(q => P.starred.includes(qKey(q))));
  if (mode === 'all') return P.settings.shuffle ? shuffled(qs) : qs;
  // экзамен дня: по три вопроса на предмет, набор один для всех — seed от даты
  if (mode === 'daily') return SUBJECTS.flatMap((s, i) => D.seededSample(bySubject(s.id), 3, D.dailySeed(today()) + i * 101));
  // plan: сначала просроченные (в первую очередь проблемные), потом новые до нормы
  const dueOld = shuffled(qs.filter(q => card(q).seen > 0 && isDue(q))).sort((a, b) => card(b).wrong - card(a).wrong);
  // финальная прямая (два дня до экзамена): новых нет — ошибки и просроченное
  if (D.isFinalStretch(P.settings.examDate, today())) {
    const wrongNotDue = shuffled(qs.filter(q => card(q).seen > 0 && !isDue(q) && card(q).wrong > 0));
    const review = dueOld.concat(wrongNotDue);
    if (review.length) return review; // нечего повторять (свежий профиль) — обычный план ниже
  }
  const fresh = shuffled(qs.filter(isNew)).slice(0, P.settings.newPerDay);
  return dueOld.concat(fresh);
}

let searchQuery = '';
const foldText = x => String(x || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
function searchQuestions(query) {
  const qn = foldText(query).trim();
  if (qn.length < 2) return null;
  const out = [];
  for (const q of QUESTIONS) {
    const hay = foldText([q.questionKa, q.questionRu, q.questionEn, q.questionUk, ...(q.optionsKa || []), ...(q.optionsRu || []), ...(q.optionsEn || []), ...(q.optionsUk || [])].join(' '));
    if (hay.includes(qn)) { out.push(q); if (out.length >= 30) break; }
  }
  return out;
}
// один вопрос из поиска — короткое занятие из одной карточки
const subjReady = id => { const qs = bySubject(id); return D.readiness(qs.map(card), qs.length); }; // 'all' — по всему банку
// восстановление гражданства: сдаётся только язык — три предмета не показываем как цель
const isRestore = () => P.settings.procedure === 'restore';
const goalSubjects = () => (isRestore() ? SUBJECTS.filter(s => s.id === 'language') : SUBJECTS);
function openQuestion(q) {
  peekKey = null; closeNote();
  session = { kind: 'study', subject: q.subject, section: 'all', mode: 'search', queue: [q], i: 0, answers: new Map(), right: 0, readyAt: subjReady(q.subject) };
  persistSession(); nav = 'study'; render();
}

// тренировка одного правила: сначала то, что пора повторить и где были ошибки, потом новое
function startRule(rule) {
  const qs = ruleQuestions(rule);
  if (!qs.length) return;
  const rank = q => (card(q).seen > 0 && isDue(q) ? 0 : card(q).wrong > 0 ? 1 : isNew(q) ? 2 : 3);
  const queue = shuffled(qs).sort((a, b) => rank(a) - rank(b));
  peekKey = null; closeNote();
  session = { kind: 'study', subject: 'language', section: 'all', mode: 'rule', queue, i: 0, answers: new Map(), right: 0, readyAt: subjReady('language'), day: today() };
  persistSession(); nav = 'study'; render();
}

function startStudy(subject, section, mode, limit) {
  let queue = pickQueue(subject, section, mode);
  if (limit) queue = queue.slice(0, limit); // «начать с 10 вопросов»
  if (!queue.length) { toast(t('Нечего повторять — возьми новые вопросы')); return false; }
  peekKey = null; closeNote();
  session = { kind: 'study', subject, section, mode, queue, i: 0, answers: new Map(), right: 0, readyAt: subjReady(subject), day: today() };
  if (mode === 'daily') {
    // одна попытка в день: засчитываем при старте, чтобы её нельзя было бросить и начать заново
    P.stats.dailyDay = today(); P.stats.dailyScore = 0; P.stats.dailyCount = (P.stats.dailyCount || 0) + 1;
    save();
  }
  persistSession();
  nav = 'study'; render();
  return true;
}

/* ------------------------------- ЭКЗАМЕН ---------------------------------- */
function screenExam() {
  if (session && session.kind === 'exam') return session.finished ? renderExamResult() : session.between ? renderBlockIntro() : renderRunner();

  const wrap = el('div', 'view-inner');
  wrap.append(el('h1', null, t('Экзамен')));


  // день экзамена: как проходит тест — каждая строка со своим источником
  const brief = el('details', 'card brief');
  if (openBrief) { brief.open = true; brief.dataset.scrollHere = '1'; openBrief = false; }
  brief.innerHTML = `<summary><span class="t"><b>${t('День экзамена: как проходит тест')}</b><span class="note">${t('сверено {0}', [fmtDate(PATH_CHECKED)])}</span></span></summary>`;
  const bl = el('ul', 'plain-list'); bl.setAttribute('role', 'list');
  [[isRestore() ? t('10 вопросов по языку, 20 минут, минимум 7 верных') : t('30 вопросов: по 10 на язык, историю и право, 20 минут на предмет, минимум 7 верных в каждом'), t('приказ №996')],
   [t('Тест электронный, на компьютере'), t('sda.gov.ge')],
   [t('Всё только по-грузински — перевода и озвучки нет'), t('по отзывам')],
   [t('Результат показывается на экране сразу после завершения'), t('приказ №996')],
   [t('Прийти за 15 минут с документом, удостоверяющим личность, и памяткой о регистрации'), t('приказ №996')],
   [t('Первая попытка бесплатна, повторная — 40 GEL (в консульстве 15 USD); результат действует год'), t('sda.gov.ge / приказ №996')]]
    .forEach(([line, src]) => { const li = el('li'); li.innerHTML = `${esc(line)} <span class="src">${esc(src)}</span>`; bl.append(li); });
  brief.append(bl);
  wrap.append(brief);

  const full = el('div', 'card');
  full.append(el('h2', null, isRestore() ? t('Тест по языку') : t('Полная симуляция')));
  const strictLab = el('label', 'row check-row', t(`<input type="checkbox" {0}> Как на настоящем: только грузинский, без озвучки и подсказок`, [P.settings.strict ? 'checked' : '']));
  strictLab.querySelector('input').onchange = e => { P.settings.strict = e.target.checked; save(); };
  full.append(strictLab);
  {
    // подсказать боевой режим, когда готовность позволяет или экзамен близко
    const scores = goalSubjects().map(s => subjReady(s.id));
    const soon = P.settings.examDate && D.daysUntil(P.settings.examDate, today()) >= 0 && D.daysUntil(P.settings.examDate, today()) <= 7;
    if (!P.settings.strict && (soon || scores.every(r => D.readinessState(r) !== 'early'))) full.append(el('p', 'note', t('Готовность позволяет — попробуй как на настоящем: на экзамене перевода и озвучки не будет.')));
  }
  full.append(el('p', 'muted', t('30 вопросов: три блока по 10 (язык, история, право), по 20 минут на блок. Сдано только если в каждом блоке минимум 7 правильных — сильный блок не спасает слабый.')));
  const b1 = el('button', 'btn block', t('Начать экзамен (1 час)'));
  if (isRestore()) full.append(el('p', 'note', t('Режим «восстановление гражданства»: сдаётся только грузинский язык — один блок из 10 вопросов, 20 минут, порог 7/10.')));
  b1.onclick = () => startExam(goalSubjects().map(s => s.id));
  full.append(b1);
  wrap.append(full);

  // экзамен дня: у всех один набор из 9 вопросов, одна попытка в день
  const daily = el('div', 'card');
  daily.append(el('h2', null, `${icon('calendar')} ${t('Экзамен дня')}`));
  if (session && session.kind === 'study' && session.mode === 'daily') {
    daily.append(el('p', 'muted', t('Экзамен дня начат — вопрос {0} из {1}.', [session.i + 1, session.queue.length])));
    const cont = el('button', 'btn block', t('Продолжить'));
    cont.onclick = () => { nav = 'study'; render(); };
    daily.append(cont);
  } else if (P.stats.dailyDay === today()) {
    daily.append(el('div', `verdict ${P.stats.dailyScore >= 7 ? 'ok' : 'no'}`, t('Сегодня: {0} из 9 · лучший результат {1} · сыграно дней: {2}', [P.stats.dailyScore, P.stats.dailyBest, P.stats.dailyCount])));
    const sh = el('button', 'btn ghost', `${icon('share')} ${t('Поделиться')}`);
    sh.onclick = () => shareText(t('Экзамен дня {0}: {1} из 9 — тренажёр на гражданство Грузии (მოქალაქეობა). А у тебя?', [fmtDate(today()), P.stats.dailyScore]));
    daily.append(sh);
  } else {
    daily.append(el('p', 'muted', t('9 вопросов — по три из каждого предмета, у всех одинаковые. Одна попытка в день, результат можно отправить друзьям.')));
    const go = el('button', 'btn block', t('Начать экзамен дня'));
    go.onclick = () => startStudy(ALL_SUBJECTS, 'all', 'daily');
    daily.append(go);
  }
  wrap.append(daily);

  const one = el('div', 'card');
  one.append(el('h2', null, t('Один блок')));
  one.append(el('p', 'muted', t('10 случайных вопросов одного предмета, 20 минут, порог 7/10.')));
  const row = el('div', 'row');
  SUBJECTS.forEach(s => {
    const b = el('button', 'btn ghost', subjName(s));
    b.onclick = () => startExam([s.id]);
    row.append(b);
  });
  one.append(row);
  wrap.append(one);

  // вызов другу: код задаёт набор вопросов, оба сдают одно и то же и сравнивают в чате
  const ch = el('div', 'card');
  ch.append(el('h2', null, `${icon('users')} ${t('Вызов другу')}`));
  ch.append(el('p', 'muted', t('Создай вызов — получишь код и полный экзамен из 30 вопросов. Друг вводит код и получает те же вопросы. Кто наберёт больше?')));
  const rowC = el('div', 'row actions-grid');
  const mk = el('button', 'btn', t('Создать вызов'));
  mk.onclick = () => { const seed = Math.floor(Math.random() * 36 ** 5); startExam(SUBJECTS.map(s => s.id), { seed, code: D.codeFromSeed(seed) }); };
  rowC.append(mk);
  ch.append(rowC);
  const rowI = el('div', 'row');
  const inp = el('input'); inp.type = 'text'; inp.placeholder = t('Код друга'); inp.maxLength = 8; inp.autocapitalize = 'characters'; inp.autocomplete = 'off';
  inp.setAttribute('aria-label', t('Код друга')); inp.style.flex = '1 1 8rem'; inp.style.minWidth = '0';
  const goC = el('button', 'btn ghost', t('Начать по коду'));
  goC.onclick = () => {
    const seed = D.seedFromCode(inp.value);
    if (seed === null) { toast(t('Код — от 3 до 5 букв и цифр')); inp.focus(); return; }
    startExam(SUBJECTS.map(s => s.id), { seed, code: D.codeFromSeed(seed) });
  };
  inp.maxLength = 7; // пять знаков плюс мусор вроде пробелов
  inp.onkeydown = e => { if (e.key === 'Enter') goC.click(); };
  rowI.append(inp, goC);
  ch.append(rowI);
  wrap.append(ch);

  if (P.exams.length) {
    const hist = el('div', 'card');
    hist.append(el('h2', 'h3', t('Последние попытки')));
    const order = ['language', 'history', 'law'];
    const list = el('ul', 'rows'); list.setAttribute('role', 'list');
    P.exams.slice(-10).reverse().forEach(e => {
      // значения из импортированного файла уже приведены к числам в normalizeProgress; здесь — страховка
      const cell = v => { const n = Number(v); return Number.isFinite(n) ? `<span class="badge ${n >= PASS_MARK ? 'ok' : 'no'}">${n}</span>` : '—'; };
      const li = el('li');
      li.append(el('span', 'name', `<b>${esc(fmtDateShort(e.day) || '—')}</b> <span class="res ${e.passed ? 'ok' : 'no'}">${e.passed ? t('сдан') : t('не сдан')}</span>`));
      li.append(el('span', 'vals', order.map(k => `<span class="v">${esc(subjName(SUBJ[k]))} ${cell(e.blocks[k])}</span>`).join('')
        + (e.code ? `<span class="v code-chip">${t('код')} <b>${esc(e.code)}</b></span>` : '')));
      if (e.code) {
        const sh = el('button', 'link-btn small', `↗ ${t('Отправить код')}`);
        sh.onclick = () => shareText(t('Мой результат в тренажёре гражданства: {0}. Попробуй тот же набор — код {1}', [order.map(k => e.blocks[k] ?? '—').join('/'), e.code]));
        li.append(sh);
      }
      list.append(li);
    });
    hist.append(list);
    wrap.append(hist);
  }
  return wrap;
}

// opts.seed — детерминированный набор (вызов другу: оба получают одни вопросы), opts.code — его код
function startExam(subjects, opts = {}) {
  peekKey = null; closeNote(); // хвосты занятия не должны попасть в экзамен
  // дедлайн блока — абсолютная метка времени: сворачивание и смерть процесса
  // не останавливают экзаменационные часы
  const pick = (arr, i) => (Number.isFinite(opts.seed) ? D.seededSample(arr, BLOCK_SIZE, opts.seed + i * 101) : sample(arr, BLOCK_SIZE));
  const blocks = subjects.map((s, i) => ({ subject: s, queue: pick(bySubject(s), i), answers: new Map(), endsAt: null, done: false }));
  blocks[0].endsAt = Date.now() + BLOCK_SECONDS * 1000;
  session = { kind: 'exam', blocks, b: 0, i: 0, finished: false, startedAt: Date.now(), seed: Number.isFinite(opts.seed) ? opts.seed : null, code: opts.code || null };
  nav = 'exam';
  persistSession();
  startTimer();
  render();
}

function blockLeft(blk) {
  return blk.endsAt ? Math.max(0, Math.ceil((blk.endsAt - Date.now()) / 1000)) : BLOCK_SECONDS;
}

// закрывает все блоки, чей дедлайн уже прошёл (например, пока приложение было в фоне)
function checkExamClock() {
  while (session && session.kind === 'exam' && !session.finished && blockLeft(session.blocks[session.b]) <= 0) {
    nextBlock(true);
  }
}

let timerId = null;
function startTimer() {
  clearInterval(timerId);
  timerId = setInterval(() => {
    if (!session || session.kind !== 'exam' || session.finished) return clearInterval(timerId);
    const left = blockLeft(session.blocks[session.b]);
    if (left <= 0) { checkExamClock(); return; }
    const tm = document.getElementById('timerVal');
    if (tm) { tm.textContent = fmt(left); tm.classList.toggle('low', left < 120); }
  }, 250);
}
const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

function nextBlock(timeout) {
  // истечение по таймеру закрывает и открытый confirm-диалог — он уже неактуален
  if (timeout) document.querySelector('.modal-back .btn.ghost')?.click();
  const blk = session.blocks[session.b];
  blk.done = true;
  if (session.b < session.blocks.length - 1) {
    // между блоками — экран паузы: таймер следующего блока стартует по кнопке
    session.b++; session.i = 0;
    session.between = true;
    session.blocks[session.b].endsAt = null;
    persistSession();
    if (timeout) toast(t('Время блока вышло — переходим к следующему'));
    render();
  } else {
    finishExam();
  }
}

function renderBlockIntro() {
  const wrap = el('div', 'view-inner');
  const blk = session.blocks[session.b], prev = session.blocks[session.b - 1];
  wrap.append(el('h1', null, t('Блок {0} из {1}', [session.b + 1, session.blocks.length])));
  const c = el('div', 'card block-intro');
  c.append(el('div', 'intro-subj', `<b>${subjName(SUBJ[blk.subject])}</b> <span class="muted ka">${subjSub(SUBJ[blk.subject])}</span>`));
  c.append(el('p', 'muted', t('{0} вопросов · {1} минут · порог {2}/10', [BLOCK_SIZE, BLOCK_SECONDS / 60, PASS_MARK])));
  if (session.code) c.append(el('p', 'note', `${t('Код вызова')}: <b>${esc(session.code)}</b>`));
  if (prev) c.append(el('p', 'note', t('Таймер блока запустится по кнопке. Предыдущий блок: отвечено {0} из {1}.', [prev.answers.size, prev.queue.length])));
  const go = el('button', 'btn block', t('Начать блок'));
  go.onclick = () => {
    session.between = false;
    blk.endsAt = Date.now() + BLOCK_SECONDS * 1000;
    persistSession(); startTimer(); render();
  };
  c.append(go);
  wrap.append(c);
  return wrap;
}

function finishExam() {
  clearInterval(timerId);
  session.finished = true;
  store.del(SESSION_KEY);
  const { blocks, passed } = D.scoreExam(session.blocks);
  // отвеченные вопросы идут в SRS: верные поднимают уровень, ошибки сбрасывают
  badgeHold = true; // «экзамен сдан» и «все блоки 9+» считаются после записи результата
  session.blocks.forEach(blk => blk.queue.forEach(q => {
    const a = blk.answers.get(qKey(q));
    if (a != null) grade(q, a === q.correct);
  }));
  badgeHold = false;
  P.stats.examsTaken++;
  if (passed) P.stats.examsPassed++;
  const entry = { day: today(), blocks, passed, seconds: Math.round((Date.now() - session.startedAt) / 1000) };
  if (session.code) entry.code = session.code; // вызов другу: код нужен и после закрытия результата
  P.exams.push(entry);
  touchDay(); save();
  checkBadges();
  haptic(passed ? 'ok' : 'error');
  render();
  if (passed) {
    setTimeout(() => { cheer(); confetti(80); }, 350);
    if (P.stats.examsPassed === 1) setTimeout(() => requestReview('exam'), 4500); // после поздравления
    if (!P.settings.examDate) setTimeout(() => toast(t('Задай дату экзамена в настройках — план подстроится под неё.')), 4800);
  }
}

function renderExamResult() {
  const wrap = el('div', 'view-inner');
  const last = P.exams[P.exams.length - 1];
  wrap.append(el('h1', null, last.passed ? t('Экзамен сдан') : t('Экзамен не сдан')));
  const c = el('div', 'card');
  if (last.passed && I18N.lang !== 'ka') {
    // та же фраза, что в поздравлении, остаётся на экране результата
    const ka = el('p', 'cheer-inline', 'გილოცავ! გამოცდა ჩაბარებულია'); ka.lang = 'ka';
    c.append(ka);
  }
  c.append(el('div', `verdict ${last.passed ? 'ok' : 'no'}`,
    last.passed ? t(`Все блоки ≥ {0}/10. За {1}.`, [PASS_MARK, fmt(last.seconds)])
                : t(`Нужно {0}/10 в каждом блоке. Провалены: {1}.`, [PASS_MARK, Object.entries(last.blocks).filter(([, v]) => v < PASS_MARK).map(([k]) => subjName(SUBJ[k])).join(', ')])));
  {
    const scores = goalSubjects().map(s => subjReady(s.id));
    c.append(el('p', 'note chance', t('Шанс сдать все блоки на настоящем экзамене: ~{0}% — оценка модели по твоему прогрессу, не статистика сдач.', [Math.round(D.passChance(scores) * 100)])));
  }
  // балл блока — десять кружков, как в бланке: закрашено столько, сколько верных; седьмой отмечен как порог
  const sheet = el('ul', 'score-sheet'); sheet.setAttribute('role', 'list');
  Object.entries(last.blocks).forEach(([k, v]) => {
    const li = el('li', v >= PASS_MARK ? 'pass' : 'fail');
    li.setAttribute('aria-label', `${subjName(SUBJ[k])}: ${v}/10`);
    li.innerHTML = `<span class="ss-name">${subjName(SUBJ[k])}</span><span class="bubbles" aria-hidden="true">${Array.from({ length: 10 }, (_, i) => `<i class="${i < v ? 'on' : ''}${i === PASS_MARK - 1 ? ' mark' : ''}"></i>`).join('')}</span><b class="ss-score">${v}/10</b>`;
    sheet.append(li);
  });
  c.append(sheet);
  wrap.append(c);

  // разбор ошибок
  const wrong = [];
  session.blocks.forEach(blk => blk.queue.forEach(q => { if (blk.answers.get(qKey(q)) !== q.correct) wrong.push([q, blk.answers.get(qKey(q))]); }));
  if (wrong.length) {
    const c2 = el('div', 'card');
    c2.append(el('h2', 'h3', t(`Разбор ошибок ({0})`, [wrong.length])));
    wrong.slice(0, 12).forEach(([q, a]) => {
      const box = el('div');
      box.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding-bottom:var(--space-3);border-bottom:1px solid var(--border)';
      box.append(el('div', 'note', `${subjName(SUBJ[q.subject])} · ${esc(trSection(q))}`));
      box.append(el('div', 'qtext ka', esc(q.questionKa)));
      box.append(el('div', 'qtrans', esc(trQuestion(q))));
      box.append(el('div', 'note', t(`<b>Верно:</b> {0}`, [esc(trOptions(q)[q.correct])])));
      if (a != null) box.append(el('div', 'note', t(`Твой ответ: {0}`, [esc(trOptions(q)[a])])));
      if (trExplanation(q) && P.settings.explain !== 'off') {
        const why = el('div', 'why', esc(trExplanation(q)));
        if (q.keyDisputed) why.append(el('span', 'why-key', t('Ответ дан по ключу агентства: в источниках встречается и другая версия, но на экзамене засчитывается этот вариант.')));
        box.append(why);
      }
      c2.append(box);
    });
    if (wrong.length > 12) c2.append(el('p', 'note', t(`Показаны первые 12. Остальные ждут в режиме «Ошибки».`)));
    wrap.append(c2);
  }

  const row = el('div', 'row actions-grid');
  const again = el('button', 'btn', t('Ещё раз'));
  again.onclick = () => startExam(session.blocks.map(b => b.subject));
  if (last.passed) {
    // сдавший — самый убедительный рекомендатель: предлагаем рассказать тем, кто готовится
    const tell = el('button', 'btn ghost', `${icon('users')} ${t('Расскажи тем, кто готовится')}`);
    tell.onclick = () => shareText(tellOthersText('exam'));
    c.append(tell);
  }
  if (session.code) {
    // вызов другу: код показываем и даём отправить — сравнить результаты можно в чате
    const cc = el('div', 'verdict ok challenge');
    cc.append(el('span', null, `${t('Код вызова')}: <b class="code">${esc(session.code)}</b>`));
    const sb = el('button', 'btn ghost small', t('Отправить код'));
    sb.onclick = () => shareText(t('Мой результат в тренажёре гражданства: {0}. Попробуй тот же набор — код {1}', [Object.values(last.blocks).join('/'), session.code]));
    cc.append(sb);
    c.append(cc);
  }
  const toMistakes = el('button', 'btn ghost', t('Разобрать ошибки в тренажёре'));
  toMistakes.onclick = () => {
    session = null; persistSession();
    if (!startStudy(ALL_SUBJECTS, 'all', 'mistakes')) { nav = 'home'; render(); }
  };
  const close = el('button', 'btn ghost', t('Закрыть'));
  close.onclick = () => { session = null; nav = 'home'; render(); };
  const shareBtn = el('button', 'btn ghost', `${icon('share')} ${t('Поделиться')}`);
  shareBtn.onclick = () => shareResult(last);
  row.append(again, toMistakes, shareBtn, close);
  wrap.append(row);
  return wrap;
}

// Карточка результата 1080×1350 для мессенджеров: рисуем на canvas, отдаём
// через системный Share (в приложении) или скачиванием (в браузере).
async function shareResult(e) {
  try { await document.fonts?.ready; } catch { /* шрифты подтянутся системные */ }
  const W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, '#0b5c46'); grad.addColorStop(1, '#062e23');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff'; g.textBaseline = 'top';
  // шрифт уменьшаем, пока строка не влезет в поля (грузинский вердикт шире холста)
  const fit = (text, px, weight) => {
    for (let size = px; ; size -= 4) {
      g.font = `${weight} ${size}px Inter, "Noto Sans Georgian", sans-serif`;
      if (size <= 24 || g.measureText(text).width <= W - 160) return;
    }
  };
  g.font = '800 64px "Noto Sans Georgian", Inter, sans-serif'; g.fillText('მოქალაქეობა', 80, 80);
  g.fillStyle = '#cfe5db';
  const title = t('Пробный экзамен на гражданство Грузии'); fit(title, 36, 500); g.fillText(title, 80, 170);
  g.fillText(fmtDate(e.day) || '', 80, 220);
  g.fillStyle = '#fff';
  const verdict = e.passed ? t('Экзамен сдан') : t('Экзамен не сдан'); fit(verdict, 96, 800); g.fillText(verdict, 80, 320);
  let y = 500;
  for (const k of ['language', 'history', 'law']) {
    const v = e.blocks[k]; if (v == null) continue;
    g.fillStyle = '#fff'; g.font = '700 48px Inter, "Noto Sans Georgian", sans-serif';
    g.fillText(subjName(SUBJ[k]), 80, y);
    g.textAlign = 'right'; g.fillText(`${v}/10`, W - 80, y); g.textAlign = 'left';
    g.fillStyle = '#ffffff33'; g.fillRect(80, y + 76, W - 160, 22);
    g.fillStyle = v >= PASS_MARK ? '#7fd6b3' : '#ff9d8e'; g.fillRect(80, y + 76, Math.round((W - 160) * v / 10), 22);
    y += 170;
  }
  g.fillStyle = '#cfe5db';
  for (const [text, y0] of [[t('Порог — 7 из 10 в каждом блоке'), H - 200], [t('Тренажёр на гражданство Грузии'), H - 140]]) { fit(text, 34, 500); g.fillText(text, 80, y0); }
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  const fs = capFs(), share = window.Capacitor?.Plugins?.Share;
  const name = `exam-${e.day || today()}.png`;
  if (fs && share && blob) {
    try {
      const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
      const w = await fs.writeFile({ path: name, directory: 'CACHE', data: b64 });
      await share.share({ title: t('Результат пробного экзамена'), files: [w.uri], dialogTitle: t('Поделиться') });
    } catch { /* пользователь закрыл шэринг */ }
    return;
  }
  if (blob) download(blob, name);
}

// Короткий текст наружу: системный шэринг в приложении, Web Share в браузере, иначе — буфер обмена
async function shareText(text) {
  try {
    const share = window.Capacitor?.Plugins?.Share;
    if (share) { await share.share({ text, dialogTitle: t('Поделиться') }); return; }
    if (navigator.share) { await navigator.share({ text }); return; }
    await navigator.clipboard?.writeText(text);
    toast(t('Скопировано'));
  } catch { /* пользователь закрыл окно шэринга */ }
}

// Скачивание в браузере: ссылка должна быть в DOM (Firefox), а blob-URL нельзя
// отзывать сразу — Chromium стартует скачивание асинхронно и потеряет данные.
function download(blob, name) {
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = name; a.hidden = true;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/* ------------------------------- РАННЕР ----------------------------------- */
function currentQuestion() {
  if (session.kind === 'exam') {
    const blk = session.blocks[session.b];
    return { q: blk.queue[session.i], answers: blk.answers, total: blk.queue.length };
  }
  return { q: session.queue[session.i], answers: session.answers, total: session.queue.length };
}

// Сетка номеров блока: отвечен, помечен «вернуться», текущий, нетронутый.
// По номеру можно прыгнуть к вопросу — иначе пропущенный ищется перелистыванием.
function questionMap(blk, total) {
  const map = el('div', 'qmap');
  map.setAttribute('role', 'group');
  map.setAttribute('aria-label', t('Вопросы блока'));
  blk.queue.forEach((qq, idx) => {
    const k = qKey(qq);
    const b = el('button', 'qmap-cell', String(idx + 1));
    const answered = blk.answers.get(k) != null;
    const flagged = session.flagged?.has(k);
    if (idx === session.i) b.classList.add('current');
    if (answered) b.classList.add('answered');
    if (flagged) b.classList.add('flagged');
    const state = answered ? t('отвечен') : t('без ответа');
    b.setAttribute('aria-label', t(`Вопрос {0}: {1}{2}`, [idx + 1, state, flagged ? t(', помечен') : '']));
    if (idx === session.i) b.setAttribute('aria-current', 'true');
    b.onclick = () => { session.i = idx; persistSession(); renderInPlace(); };
    map.append(b);
  });
  return map;
}

function renderRunner() {
  const { q, answers, total } = currentQuestion();
  const wrap = el('div', 'view-inner');
  const isExam = session.kind === 'exam';
  const blk = isExam ? session.blocks[session.b] : null;
  const given = answers.get(qKey(q));
  const revealed = !isExam && given != null;

  // заголовок сессии — строка над листом вопроса, не отдельная карточка
  const head = el('div', 'run-head');
  const title = isExam
    ? t(`Блок {0}/{1} · {2}`, [session.b + 1, session.blocks.length, subjName(SUBJ[blk.subject])])
    : `${session.subject === ALL_SUBJECTS ? t('Все предметы') : subjName(SUBJ[session.subject])} · ${({ plan: t('по плану'), mistakes: t('ошибки'), leech: t('проблемные'), starred: t('закладки'), all: t('все вопросы'), search: t('поиск'), daily: t('экзамен дня'), rule: t('правило') })[session.mode]}`;
  const right = isExam
    ? t(`<span class="timer" id="timerVal" role="timer" aria-label="Осталось времени в блоке">{0}</span>`, [fmt(blockLeft(blk))])
    : `<span class="badge ok">${session.right}/${answers.size}</span>`;
  const answeredNote = isExam ? t(` · отвечено {0}/{1}`, [blk.answers.size, total]) : '';
  head.append(el('div', 'spread', t(`<div><h1 class="run-title">{0}</h1><span class="note">вопрос {1} из {2}{3}</span></div>{4}`, [title, session.i + 1, total, answeredNote, right])));
  if (isExam) {
    head.append(questionMap(blk, total));
  } else {
    const bar = el('div', 'bar'); bar.append(el('i'));
    bar.firstChild.style.width = `${(session.i) / total * 100}%`;
    head.append(bar);
  }
  wrap.append(head);

  // сам вопрос; «как на настоящем» — только грузинский, без озвучки и подсказок
  const strictExam = isExam && !!P.settings.strict;
  const tx = texts(q, strictExam ? 'ka' : undefined);
  const c = el('div', 'card');
  const meta = el('div', 'qmeta');
  meta.innerHTML = `<span>${esc(trSection(q))} · №${q.id}</span>`;
  const metaBtns = el('div', 'row');
  const speakBtn = el('button', 'icon-btn', icon('volume'));
  speakBtn.title = t('Озвучить по-грузински');
  speakBtn.setAttribute('aria-label', t('Озвучить вопрос по-грузински'));
  speakBtn.onclick = () => speak(q.questionKa);
  const starred = P.starred.includes(qKey(q));
  if (isExam) {
    const k = qKey(q);
    const isFlagged = session.flagged?.has(k);
    const flagBtn = el('button', 'icon-btn' + (isFlagged ? ' on' : ''), icon('flag', isFlagged));
    flagBtn.title = t('Вернуться к вопросу позже');
    flagBtn.setAttribute('aria-label', isFlagged ? t('Снять пометку с вопроса') : t('Пометить, чтобы вернуться позже'));
    flagBtn.setAttribute('aria-pressed', String(!!isFlagged));
    flagBtn.onclick = () => {
      session.flagged ||= new Set();
      if (isFlagged) session.flagged.delete(k); else session.flagged.add(k);
      persistSession();
      renderInPlace();
    };
    metaBtns.append(flagBtn);
  }
  const starBtn = el('button', 'icon-btn' + (starred ? ' on' : ''), icon('star', starred));
  starBtn.title = t('В закладки');
  starBtn.setAttribute('aria-label', starred ? t('Убрать из закладок') : t('Добавить в закладки'));
  starBtn.setAttribute('aria-pressed', String(starred));
  starBtn.onclick = () => {
    const k = qKey(q);
    P.starred = P.starred.includes(k) ? P.starred.filter(x => x !== k) : P.starred.concat(k);
    save(); renderInPlace();
  };
  const hasNote = !!P.notes[qKey(q)];
  const noteBtn = el('button', 'icon-btn' + (hasNote ? ' on' : ''), icon('pencil'));
  noteBtn.title = t('Заметка');
  noteBtn.setAttribute('aria-label', hasNote ? t('Изменить заметку') : t('Добавить заметку'));
  noteBtn.setAttribute('aria-expanded', String(noteOpen === qKey(q)));
  noteBtn.onclick = () => { const open = noteOpen !== qKey(q); closeNote(); if (open) noteOpen = qKey(q); renderInPlace(); };
  if (!strictExam) metaBtns.append(speakBtn);
  metaBtns.append(starBtn);
  if (!isExam) metaBtns.append(noteBtn); // в экзамене заметка была бы подсказкой
  meta.append(metaBtns);
  c.append(meta);
  const qEl = el('div', `qtext ${tx.mainKa ? 'ka' : ''}`, esc(tx.main));
  if (tx.mainKa) qEl.lang = 'ka';
  c.append(qEl);
  if (tx.sub) {
    const subEl = el('div', 'qtrans' + (tx.subKa ? ' ka' : ''), esc(tx.sub));
    if (tx.subKa) subEl.lang = 'ka';
    c.append(subEl);
  } else if (!strictExam && P.settings.display === 'ka' && tx.hasTr) {
    // режим «только KA»: перевод можно подсмотреть для этого вопроса
    const peek = el('button', 'btn ghost small peek-btn', `${icon('eye')} ${t('Подсмотреть перевод')}`);
    peek.onclick = () => { peekKey = qKey(q); renderInPlace(); };
    c.append(peek);
  }

  // заметка: своя подсказка-мнемоника к вопросу — показывается под вопросом,
  // редактируется на месте
  const nk = qKey(q);
  if (!isExam && noteOpen === nk) {
    const ed = el('div', 'note-edit');
    const ta = el('textarea'); ta.maxLength = D.NOTE_MAX; ta.rows = 3; ta.value = noteDraft ?? P.notes[nk] ?? '';
    ta.placeholder = t('Как запомнить этот вопрос…'); ta.setAttribute('aria-label', t('Заметка'));
    ta.oninput = () => { noteDraft = ta.value; }; // ответ, закладка, флажок перерисовывают карточку — черновик не теряем
    const rowB = el('div', 'row');
    const saveB = el('button', 'btn small', t('Сохранить'));
    saveB.onclick = () => { const v = ta.value.trim().slice(0, D.NOTE_MAX); if (v) P.notes[nk] = v; else delete P.notes[nk]; closeNote(); save(); renderInPlace(); };
    const cancelB = el('button', 'btn ghost small', t('Отмена'));
    cancelB.onclick = () => { closeNote(); renderInPlace(); };
    rowB.append(saveB, cancelB);
    if (P.notes[nk]) { const del = el('button', 'btn ghost small', t('Удалить')); del.onclick = () => { delete P.notes[nk]; closeNote(); save(); renderInPlace(); }; rowB.append(del); }
    ed.append(ta, rowB); c.append(ed);
    requestAnimationFrame(() => ta.focus({ preventScroll: true }));
  } else if (!isExam && P.notes[nk]) {
    c.append(el('div', 'note-box', `<b>${t('Заметка')}:</b> ${esc(P.notes[nk])}`));
  }

  if (!isExam && given == null) {
    // «уверен / сомневаюсь» до ответа: сомнение + верно = угадал, уверенность + ошибка — особая
    const conf = session.confKey === qKey(q) ? session.conf : null;
    const cf = el('div', 'conf');
    cf.append(el('span', null, t('Насколько уверен?')));
    [['sure', t('Уверен')], ['unsure', t('Сомневаюсь')]].forEach(([id, label]) => {
      const b = el('button', null, label); b.type = 'button'; b.dataset.key = `conf:${id}`;
      b.setAttribute('aria-pressed', String(conf === id));
      b.onclick = () => { session.confKey = qKey(q); session.conf = conf === id ? null : id; renderInPlace(); };
      cf.append(b);
    });
    c.append(cf);
  }
  const opts = el('div', 'opts');
  const order = P.settings.shuffle ? (session.orderCache ||= new Map()) : null;
  let indexes = tx.opts.map(o => o.index);
  if (order) {
    if (!order.has(qKey(q))) order.set(qKey(q), shuffled(indexes));
    indexes = order.get(qKey(q));
  }
  indexes.forEach((oi, pos) => {
    const o = tx.opts[oi];
    const b = el('button', 'opt');
    b.append(el('span', 'key', String.fromCharCode(65 + pos)));
    const body = el('span', 'body');
    const main = el('span', o.mainKa ? 'ka' : '', esc(o.main));
    if (o.mainKa) main.lang = 'ka';
    body.append(main);
    if (o.sub) {
      const subEl = el('span', 'sub' + (o.subKa ? ' ka' : ''), esc(o.sub));
      if (o.subKa) subEl.lang = 'ka';
      body.append(subEl);
    }
    b.append(body);
    if (revealed) {
      // aria-disabled вместо disabled: элемент остаётся доступен скринридеру
      b.setAttribute('aria-disabled', 'true');
      if (oi === q.correct) {
        b.classList.add('correct');
        b.append(el('span', 'sr-only', t(' — правильный ответ')));
      } else if (oi === given) {
        b.classList.add('wrong');
        b.append(el('span', 'sr-only', t(' — твой ответ, неверно')));
      }
    } else if (isExam && given === oi) {
      b.classList.add('selected'); // нейтральная подсветка: «выбран», а не «правильный»
      b.setAttribute('aria-pressed', 'true');
    }
    b.onclick = () => { if (b.getAttribute('aria-disabled') !== 'true') answer(oi); };
    opts.append(b);
  });
  c.append(opts);

  if (revealed) {
    const ok = given === q.correct;
    c.append(el('div', `verdict ${ok ? 'ok' : 'no'}`, ok ? t('Верно') : t(`Неверно · правильный ответ: {0}`, [esc(trOptions(q)[q.correct])])));
    {
      const conf = session.confKey === qKey(q) ? session.conf : null;
      if (!ok && conf === 'sure') c.append(el('p', 'note conf-note', t('Ты был уверен — такие ошибки запоминаются лучше всего. Перечитай объяснение.')));
      if (ok && conf === 'unsure') c.append(el('p', 'note conf-note', t('Сомневался — вопрос вернётся завтра.')));
    }
    if (session.lastAnnounced !== session.i) {
      session.lastAnnounced = session.i;
      announce(ok ? t('Верно') : t(`Неверно. Правильный ответ: {0}`, [trOptions(q)[q.correct]]));
    }
    if (!ok) c.append(el('div', 'qtrans ka', esc(q.optionsKa[q.correct])));
    if (trExplanation(q) && P.settings.explain !== 'off') {
      const why = el('div', 'why', t(`<b>Почему:</b> {0}`, [esc(trExplanation(q))]));
      if (q.keyDisputed) why.append(el('span', 'why-key', t('Ответ дан по ключу агентства: в источниках встречается и другая версия, но на экзамене засчитывается этот вариант.')));
      // грамматический вопрос — ссылка на правило из свода
      const rule = q.rule && RULES.find(r => r.id === q.rule);
      const ruleBtn = rule ? el('button', 'link-btn rule-link', `${icon('book')} ${t('Правило: {0}', [esc(ruleText(rule, 'title'))])} ${icon('chevron')}`) : null;
      if (ruleBtn) ruleBtn.onclick = () => { focusRule = rule.id; backNav = 'study'; nav = 'grammar'; render(); };
      if (P.settings.explain === 'button' && !session.whyShown?.has(qKey(q))) {
        // сначала подумать над ошибкой, потом прочитать объяснение
        why.hidden = true; if (ruleBtn) ruleBtn.hidden = true;
        const whyBtn = el('button', 'btn ghost small', t('Почему?'));
        why.tabIndex = -1; // чтобы фокус с исчезнувшей кнопки ушёл на объяснение
        whyBtn.onclick = () => { why.hidden = false; if (ruleBtn) ruleBtn.hidden = false; whyBtn.remove(); (session.whyShown ||= new Set()).add(qKey(q)); why.focus({ preventScroll: true }); announce(trExplanation(q)); };
        c.append(whyBtn);
      }
      c.append(why);
      if (ruleBtn) c.append(ruleBtn);
    }
    // сообщить об ошибке: письмо автору с текстом вопроса и ключом — банк меняли без объяснений
    const rep = el('a', 'link-btn report', `${icon('report')} ${t('Сообщить об ошибке в вопросе')}`);
    rep.href = 'mailto:' + AUTHOR_EMAIL + '?subject=' + encodeURIComponent(t('Ошибка в вопросе {0}', [qKey(q)]))
      + '&body=' + encodeURIComponent(`${q.questionKa}\n${trQuestion(q)}\n${t('Правильный ответ по ключу:')} ${'ABCD'[q.correct]} — ${q.optionsKa[q.correct]}\n\n${t('Что не так:')}\n\n—\n${t('Версия {0}', [appVersion()])}`);
    c.append(rep);
    if (ok && !session.unsureDone?.has(qKey(q))) {
      const un = el('button', 'btn ghost small', t('Угадал — повторить завтра'));
      un.onclick = () => {
        markUnsure(q); undoUp(q);
        (session.unsureDone ||= new Set()).add(qKey(q));
        persistSession();
        toast(t('Отложил на завтра — угаданное не считается выученным'));
        renderInPlace();
      };
      c.append(un);
    }
    const cd = card(q);
    c.append(el('p', 'note', t(`Уровень {0}/{1} · следующий показ {2} · верно {3}, ошибок {4}{5}{6}`, [cd.box, BOX_INTERVALS.length - 1, fmtDate(cd.due), cd.right, cd.wrong, cd.unsure ? t(`, угадано {0}`, [cd.unsure]) : '', isLeech(q) ? t(' · проблемный') : ''])));
  }
  wrap.append(c);

  // управление
  const ctl = el('div', 'row runner-actions');
  if (isExam) {
    const prev = el('button', 'btn ghost', t('← Назад'));
    prev.disabled = session.i === 0;
    prev.onclick = () => { session.i--; persistSession(); render(); };
    const next = el('button', 'btn ghost', t('Вперёд →'));
    next.disabled = session.i >= total - 1;
    next.onclick = () => { session.i++; persistSession(); render(); };
    const fin = el('button', 'btn', session.b < session.blocks.length - 1 ? t('Завершить блок') : t('Завершить'));
    const answered = blk.answers.size;
    fin.onclick = async () => {
      const myBlock = session.b; // пока открыт диалог, блок мог истечь и закрыться сам
      const tail = answered < total ? t(` Отвечено {0} из {1}, остальные пойдут в ошибки.`, [answered, total]) : '';
      if (await ask(t(`Завершить блок? Вернуться будет нельзя.{0}`, [tail]), t('Завершить'))) {
        if (session && session.kind === 'exam' && !session.finished && session.b === myBlock && !session.blocks[myBlock].done) {
          nextBlock(false);
        }
      }
    };
    fin.classList.add('ghost', 'small');
    ctl.append(prev, next, fin);
  } else {
    if (revealed) {
      const next = el('button', 'btn', session.i >= total - 1 ? t('К результатам') : t('Дальше →'));
      next.onclick = () => { if (session.i >= total - 1) finishStudy(); else { session.i++; render(); } };
      ctl.append(next);
    }
    const stop = el('button', 'link-btn stop-link', t('Прервать'));
    stop.onclick = () => leaveStudy();
    ctl.append(stop);
    ctl.classList.add('study-ctl');
  }
  wrap.append(ctl);
  return wrap;
}

function answer(oi) {
  const { q, answers } = currentQuestion();
  if (session.kind === 'exam') {
    answers.set(qKey(q), oi);
    persistSession();
    renderInPlace();
    return;
  }
  if (answers.get(qKey(q)) != null) return;
  answers.set(qKey(q), oi);
  const ok = oi === q.correct;
  if (ok) session.right++;
  const conf = session.confKey === qKey(q) ? session.conf : null;
  const beforeBox = card(q).box;
  (session.boxBefore ||= new Map()).set(qKey(q), beforeBox); // для отката счётчика «поднялись», если потом «угадал»
  grade(q, ok, { chosen: oi, sure: conf === 'sure' });
  // «сомневаюсь» + верно = угадал: вернётся завтра; «уверен» + ошибка — считаем отдельно
  if (ok && conf === 'unsure') { markUnsure(q); undoUp(q); (session.unsureDone ||= new Set()).add(qKey(q)); }
  if (!ok && conf === 'sure') session.sureWrong = (session.sureWrong || 0) + 1;
  persistSession();
  haptic(ok ? 'ok' : 'error');
  renderInPlace();
}

// выход из занятия: экзамен дня — одна попытка, поэтому спрашиваем
async function leaveStudy() {
  if (session?.kind === 'study' && session.mode === 'daily' && session.i < session.queue.length - 1) {
    if (!await ask(t('Экзамен дня — одна попытка в день. Выйти? Неотвеченные вопросы засчитаются как ошибки.'), t('Выйти'))) return;
  }
  finishStudy();
}
function finishStudy() {
  peekKey = null; closeNote();
  if (!session || session.kind !== 'study') { session = null; persistSession(); nav = 'home'; render(); return; }
  const s = session;
  const answered = s.answers.size;
  if (s.mode === 'daily' && s.day === today()) {
    // экзамен дня: попытка засчитана при старте, здесь — счёт; неотвеченные считаются ошибками
    P.stats.dailyScore = s.right;
    P.stats.dailyBest = Math.max(P.stats.dailyBest || 0, s.right);
    save();
  }
  if (answered) {
    // итог показывается карточкой на главной: что поднялось, что упало, сдвиг прогноза
    const tomorrow = D.addDays(today(), 1);
    lastSummary = {
      subject: s.subject, section: s.section, mode: s.mode, answered: s.mode === 'daily' ? s.queue.length : answered, right: s.right,
      up: s.up || 0, down: s.down || 0, sureWrong: s.sureWrong || 0,
      before: s.readyAt, after: subjReady(s.subject),
      dueTomorrow: QUESTIONS.filter(q => card(q).seen > 0 && card(q).due === tomorrow).length,
    };
  }
  session = null;
  persistSession();
  nav = 'home';
  render();
}
let lastSummary = null; // итог последнего занятия — до закрытия карточки или перезапуска

/* -------------------------------- МОЙ ПУТЬ -------------------------------- */
// Гид по процедуре с чек-листом и сроками. У каждой цифры — источник: закон/приказ,
// страница SDA или «по отзывам». Это не юридическая консультация.
const PATH_CHECKED = '2026-09-09';
const PATH_SOURCES = [
  ['sda.gov.ge — гражданство Грузии', 'https://sda.gov.ge/en/products/citizenship/'],
  ['Приказ Минюста №996 от 30.04.2024 (правила теста)', 'https://matsne.gov.ge/ka/document/view/6161297'],
  ['JUST Advisors — новые правила экзамена (консультанты)', 'https://en.justadvisors.ge/blog/jizn-v-gruzii/novye-pravila-ekzamenov-na-grazhdanstvo-gruzii'],
];
function pathSteps() {
  const restore = isRestore();
  const src = { law: t('закон / приказ'), sda: t('sda.gov.ge'), practice: t('по отзывам и консультантам') };
  return [
    { id: 'basis', title: t('Проверить основание'), src: src.sda,
      body: restore
        ? t('Восстановление — для тех, кто был гражданином Грузии: из тестов сдаётся только грузинский язык.')
        : t('Обычная натурализация — 10 лет непрерывного законного проживания, знание грузинского, истории и основ права. Упрощённая — для супругов граждан Грузии, 5 лет. Для лиц со статусом апатрида в Грузии — 5 лет (с 2024). Восстановление — для бывших граждан, только язык.') },
    { id: 'register', title: t('Записаться на тест'), src: src.law,
      body: t('Регистрация — лично или через представителя в SDA, Доме юстиции или консульстве (паспорт и фото); дату и время выбирают в электронном календаре при регистрации — в пределах двух месяцев, перенос не позднее чем за 48 часов до теста (приказ №996, ст. 3).') },
    { id: 'test', title: restore ? t('Сдать тест по языку') : t('Сдать тест'), src: src.law,
      body: restore
        ? t('10 вопросов по грузинскому языку, 20 минут, минимум 7 правильных (приказ №996). Первая попытка бесплатна, каждая следующая — 40 GEL (в консульстве за рубежом — 15 USD); результат действует один год.')
        : t('30 вопросов: по 10 на язык, историю и право, 20 минут на предмет, минимум 7 правильных в каждом (приказ №996). Первая попытка бесплатна, каждая следующая — 40 GEL (в консульстве за рубежом — 15 USD); результат действует один год.') },
    { id: 'result', title: t('Узнать результат'), src: src.law,
      body: t('Результат электронного теста показывается на экране сразу после завершения; позже его можно посмотреть на sda.gov.ge по номеру заявления и коду из памятки (приказ №996, ст. 4).') },
    { id: 'apply', title: t('Подать заявление'), src: src.sda,
      body: restore
        ? t('Восстановление: пошлина 130 GEL за 30 дней или 195 GEL за 20 дней. Решение — не позднее трёх месяцев.')
        : t('Пошлина зависит от срока рассмотрения: 65 GEL за 80 дней, 130 — за 60, 260 — за 40, 390 — за 20. Решение — не позднее трёх месяцев.') },
    ...(restore ? [] : [{ id: 'interview', title: t('Собеседование с комиссией'), src: src.practice,
      body: t('По рассказам сдававших: комиссия задаёт вопросы по-грузински — о тебе, семье, работе и связях с Грузией; официальный формат не опубликован. Подготовь короткие ответы.') }]),
    { id: 'oath', title: t('Присяга и паспорт'), src: src.practice,
      body: t('После положительного решения — присяга и оформление документов в Доме юстиции; срок и пошлина за паспорт зависят от срочности — уточни на месте.') },
  ];
}
function screenPath() {
  const wrap = el('div', 'view-inner');
  wrap.append(backBtn());
  wrap.append(el('h1', null, t('Мой путь к гражданству')));
  wrap.append(el('p', 'muted', t('Не юридическая консультация. Сверено с sda.gov.ge и приказом №996 {0}; правила меняются — проверяй первоисточник.', [fmtDate(PATH_CHECKED)])));

  const pc = el('div', 'card');
  pc.append(el('h2', 'h3', t('Процедура')));
  const seg = el('div', 'seg');
  [['full', t('Обычная (три предмета)')], ['restore', t('Восстановление (только язык)')]].forEach(([id, label]) => {
    const b = el('button', null, label);
    b.setAttribute('aria-pressed', String(P.settings.procedure === id));
    b.onclick = () => { P.settings.procedure = id; if (id === 'restore') P.settings.subject = 'language'; save(); render(); };
    seg.append(b);
  });
  pc.append(seg);
  wrap.append(pc);

  const steps = pathSteps();
  const list = el('ol', 'path-steps'); list.setAttribute('role', 'list');
  steps.forEach((st, idx) => {
    const done = P.path.done[st.id];
    const li = el('li', 'path-step' + (done ? ' done' : ''));
    const head = el('label', 'path-head');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!done; cb.dataset.key = `path:${st.id}`;
    cb.setAttribute('aria-label', st.title);
    cb.onchange = () => { if (cb.checked) P.path.done[st.id] = today(); else delete P.path.done[st.id]; save(); render(); };
    head.append(cb, el('span', 'num', String(idx + 1)), el('span', 'title', `<b>${esc(st.title)}</b><span class="note">${esc(st.src)}${done ? ` · ${esc(fmtDate(done))}` : ''}</span>`));
    li.append(head);
    li.append(el('p', 'muted', esc(st.body)));
    // сроки: запись → сдать в течение двух месяцев; тест → дата из настроек и «сдал?»
    if (st.id === 'register') {
      const row = el('div', 'date-row');
      const d = el('input'); d.type = 'date'; d.value = P.path.registeredOn || ''; d.setAttribute('aria-label', t('Дата записи')); d.dataset.key = 'path:registeredOn';
      d.onchange = () => { P.path.registeredOn = d.value || null; save(); render(); };
      row.append(el('span', 'note', t('Дата записи')), d);
      li.append(row);
      if (P.path.registeredOn) {
        const deadline = D.addDays(P.path.registeredOn, 61);
        const left = D.daysUntil(deadline, today());
        li.append(el('div', `verdict ${left < 0 ? 'no' : 'ok'}`, left < 0
          ? t('Два месяца после записи прошли ({0}): по приказу №996 дату теста выбирают в пределах двух месяцев от регистрации. Проверь статус в SDA.', [fmtDate(deadline)])
          : t('Сдать до {0} — осталось {1} {2}.', [fmtDate(deadline), left, I18N.plural(left, ['день', 'дня', 'дней'])])));
      }
    }
    if (st.id === 'test') {
      const ex = P.settings.examDate;
      if (!ex) li.append(el('p', 'note', t('Дата экзамена не задана — укажи её в настройках, и план дня подстроится.')));
      else {
        const left = D.daysUntil(ex, today());
        li.append(el('p', 'note', left > 0 ? t('Экзамен {0} — через {1} {2}.', [fmtDate(ex), left, I18N.plural(left, ['день', 'дня', 'дней'])]) : left === 0 ? t('Экзамен сегодня — {0}.', [fmtDate(ex)]) : t('Экзамен был {0}.', [fmtDate(ex)])));
        if (left <= 0 && !P.path.passedOn) {
          const row = el('div', 'row');
          const yes = el('button', 'btn small', t('Сдал'));
          yes.onclick = () => { P.path.passedOn = ex; P.path.done.test = today(); save(); render(); haptic('celebrate'); setTimeout(() => requestReview('passed'), 800); };
          const no = el('button', 'btn ghost small', t('Не сдал'));
          no.onclick = () => {
            P.settings.examDate = null; save(); syncExamEve();
            toast(t('Задай новую дату в настройках — повторная попытка 40 GEL (в консульстве — 15 USD).'));
            // сразу к делу: режим «Ошибки», если есть что разбирать
            if (!startStudy(P.settings.subject, 'all', 'mistakes')) render();
          };
          row.append(yes, no);
          li.append(row);
        }
      }
      if (P.path.passedOn) {
        li.append(el('div', 'verdict ok', t('Сдано {0}. Результат действует до {1}.', [fmtDate(P.path.passedOn), fmtDate(D.addDays(P.path.passedOn, 365))])));
        const row = el('div', 'row actions-grid');
        const tell = el('button', 'btn ghost small', `${icon('users')} ${t('Расскажи тем, кто готовится')}`);
        tell.onclick = () => shareText(tellOthersText('passed'));
        // три вопроса о собеседовании — единственный способ узнать формат, который агентство не публикует
        const askQ = el('a', 'btn ghost small', `${icon('mail')} ${t('Ответить на три вопроса')}`);
        askQ.href = 'mailto:' + AUTHOR_EMAIL + '?subject=' + encodeURIComponent(t('Как прошёл экзамен'))
          + '&body=' + encodeURIComponent(`${t('1. Какая процедура (обычная, упрощённая, восстановление, исключительная)?')}\n\n${t('2. Было ли собеседование с комиссией? На каком языке?')}\n\n${t('3. Что спрашивали? Что помогло бы в приложении?')}\n\n—\n${diagnostics(appVersion())}`);
        row.append(tell, askQ);
        li.append(row);
      }
    }
    list.append(li);
  });
  const lc = el('div', 'card'); lc.append(list); wrap.append(lc);

  const sc = el('div', 'card');
  sc.append(el('h2', 'h3', t('Источники')));
  const ul = el('ul', 'plain-list'); ul.setAttribute('role', 'list');
  PATH_SOURCES.forEach(([label, url]) => { const li = el('li'); const a = el('a', null, esc(t(label))); a.href = url; a.target = '_blank'; a.rel = 'noopener'; li.append(a); ul.append(li); });
  sc.append(ul);
  wrap.append(sc);
  return wrap;
}

/* ----------------------------- ЦИФРЫ ПРАВА -------------------------------- */
// Возрасты, сроки, кворумы — вопросы права, у которых верный ответ содержит число.
// Никакого нового контента: вопрос + ответ по ключу агентства, тап открывает вопрос.
const NUM_RE = /\d|(?:^|[^а-яё])(один(?![а-яё])|одн(?:а|ой|ого|у)(?![а-яё])|два|двух|три|тр[её]х|четыр|четв[её]рт|пят|шест|сем[иь]|восьм|девят|десят|двадцат|тридцат|сорок|полов|трет|пятых|большинств)/i;
// годы (1995, 2018) — не «цифры и сроки», их убираем перед проверкой
const numericLaw = () => bySubject('law').filter(q => NUM_RE.test(q.optionsRu[q.correct].replace(/\b(1[89]|20)\d\d\b/g, '')));
function screenNumbers() {
  const wrap = el('div', 'view-inner');
  wrap.append(backBtn());
  wrap.append(el('h1', null, t('Цифры и сроки права')));
  wrap.append(el('p', 'muted', t('Возрасты, сроки и кворумы из ключей агентства — то, что путают чаще всего. Нажми строку, чтобы открыть вопрос.')));
  const groups = new Map();
  numericLaw().forEach(q => { const k = trSection(q); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(q); });
  for (const [sec, qs] of groups) {
    const c = el('div', 'card');
    c.append(el('h2', 'h3', esc(sec)));
    const ul = el('ul', 'num-list'); ul.setAttribute('role', 'list');
    qs.forEach(q => {
      const li = el('li');
      const ka = I18N.lang === 'ka';
      const b = el('button', 'num-row', ka
        ? `<span class="q" lang="ka">${esc(q.questionKa)}</span><span class="a"><b lang="ka">${esc(q.optionsKa[q.correct])}</b><span class="ka" lang="${transLang()}">${esc(trOptions(q)[q.correct])}</span></span>`
        : `<span class="q">${esc(trQuestion(q))}</span><span class="a"><b>${esc(trOptions(q)[q.correct])}</b><span class="ka" lang="ka">${esc(q.optionsKa[q.correct])}</span></span>`);
      b.onclick = () => openQuestion(q);
      li.append(b); ul.append(li);
    });
    c.append(ul); wrap.append(c);
  }
  return wrap;
}

/* ------------------------------ ГРАММАТИКА -------------------------------- */
// Свод правил к грамматическим вопросам языка (www/data/rules.js). Правила составлены с помощью ИИ
// и перепроверены второй моделью по ключам агентства — в интерфейсе это сказано прямо.
const RULES = Array.isArray(window.GRAMMAR_RULES) ? window.GRAMMAR_RULES : [];
const RULE_SUFFIX = { ru: 'Ru', en: 'En', uk: 'Uk' };
const ruleText = (r, base) => r[base + RULE_SUFFIX[transLang()]] || r[base + 'Ru'] || '';
const ruleQuestions = r => (r.questions || []).map(k => byKey.get(k)).filter(Boolean);
let focusRule = null;
// Справочные экраны (грамматика, цифры, хронология, путь) открываются с трёх мест: «Материалы»,
// «Учить» и главная; кнопка «назад» ведёт туда, откуда пришли.
let backNav = 'materials';
let openBrief = false; // «День экзамена» из «Материалов»: раскрыть брифинг на экране экзамена
const BACK_LABEL = { study: 'Учить', home: 'Обзор', materials: 'Материалы' };
const backBtn = () => { const b = el('button', 'link-btn back', `‹ ${t(BACK_LABEL[backNav] || 'Материалы')}`); b.onclick = () => { nav = backNav; render(); }; return b; };
const TIMELINE = Array.isArray(window.TIMELINE) ? window.TIMELINE : [];
const PATH_STEPS_HINT = doneN => t('{0} из {1} шагов', [doneN, pathSteps().length]);
const knownOf = qs => qs.filter(q => card(q).box >= D.KNOWN_BOX).length;
function screenGrammar() {
  const wrap = el('div', 'view-inner');
  const inStudy = session && session.kind === 'study';
  if (inStudy) { const back = el('button', 'link-btn back', `‹ ${t('К вопросу')}`); back.onclick = () => { nav = 'study'; render(); }; wrap.append(back); } else wrap.append(backBtn());
  wrap.append(el('h1', null, t('Грамматика')));
  const total = RULES.reduce((a, r) => a + ruleQuestions(r).length, 0);
  wrap.append(el('p', 'muted', t('{0} {1} на {2} {3} — всё, что спрашивают про формы слов. Выучи правило, потом закрепи его вопросами из банка.', [RULES.length, I18N.plural(RULES.length, ['правило', 'правила', 'правил']), total, I18N.plural(total, ['вопрос', 'вопроса', 'вопросов'])])));
  const lang = transLang();
  RULES.forEach(r => {
    const qs = ruleQuestions(r);
    const known = qs.filter(q => card(q).box >= D.KNOWN_BOX).length;
    // правил девятнадцать: показываем список заголовков, текст раскрывается по нажатию
    const c = el('details', 'card rule');
    c.id = 'rule-' + r.id;
    if (focusRule === r.id) { c.open = true; c.dataset.scrollHere = '1'; }
    const head = el('summary');
    head.append(el('h2', 'h3', esc(ruleText(r, 'title'))));
    head.append(el('span', `badge ${known === qs.length && qs.length ? 'ok' : ''}`, `${known}/${qs.length}`));
    head.lastChild.setAttribute('aria-label', t('Выучено {0} из {1}', [known, qs.length]));
    c.append(head);
    c.append(el('p', 'rule-body', esc(ruleText(r, 'body'))));
    if (r.forms?.length) {
      const tb = el('table', 'rule-forms');
      const cap = el('caption', 'sr-only', t('Формы')); tb.append(cap);
      const body = el('tbody');
      r.forms.forEach(f => {
        const tr = el('tr');
        const th = el('th', 'ka', esc(f.ka)); th.lang = 'ka'; th.scope = 'row';
        tr.append(th, el('td', null, esc(f[lang] || f.ru || '')));
        body.append(tr);
      });
      tb.append(body); c.append(tb);
    }
    if (r.examples?.length) {
      const ul = el('ul', 'rule-ex'); ul.setAttribute('role', 'list');
      r.examples.forEach(x => {
        const li = el('li');
        const ka = el('span', 'ka', esc(x.ka)); ka.lang = 'ka';
        li.append(ka, el('span', 'muted', esc(x[lang] || x.ru || '')));
        ul.append(li);
      });
      c.append(ul);
    }
    if (qs.length) {
      const go = el('button', 'btn small', t('Тренировать · {0}', [qs.length]));
      go.dataset.key = 'rule-' + r.id;
      go.onclick = () => startRule(r);
      c.append(go);
    }
    wrap.append(c);
  });
  focusRule = null;
  const rep = el('a', 'link-btn report', `${icon('report')} ${t('Сообщить об ошибке в правиле')}`);
  rep.href = 'mailto:' + AUTHOR_EMAIL + '?subject=' + encodeURIComponent(t('Ошибка в правиле грамматики')) + '&body=' + encodeURIComponent(`${t('Что не так:')}\n\n—\n${t('Версия {0}', [appVersion()])}`);
  wrap.append(el('p', 'note', t('Правила и пояснения составлены с помощью ИИ и сверены с ключами агентства и источниками, но носитель языка их не вычитывал. Нашёл неточность — напиши.')), rep);
  return wrap;
}

/* ------------------------------ МАТЕРИАЛЫ --------------------------------- */
// Вкладка со справочниками: раньше грамматика и цифры были видны только при нужном предмете на «Учить».
function screenMaterials() {
  const wrap = el('div', 'view-inner');
  wrap.append(el('h1', null, t('Материалы')));
  wrap.append(el('p', 'muted', t('Справочники к трём предметам и путь к гражданству — то, что стоит прочитать вне занятий.')));
  const list = el('div', 'card mode-list');
  const rows = [];
  if (RULES.length) {
    const qs = RULES.flatMap(ruleQuestions);
    rows.push(['book', t('Грамматика'), `${RULES.length} ${I18N.plural(RULES.length, ['правило', 'правила', 'правил'])} · ${t('выучено {0} из {1}', [knownOf(qs), qs.length])}`, 'grammar']);
  }
  if (TIMELINE.length) {
    const qs = TIMELINE.map(e => byKey.get(e.key)).filter(Boolean);
    rows.push(['clock', t('Хронология истории'), `${t('{0} {1} от Дманиси до наших дней', [qs.length, I18N.plural(qs.length, ['дата', 'даты', 'дат'])])} · ${t('выучено {0} из {1}', [knownOf(qs), qs.length])}`, 'timeline']);
  }
  const nums = numericLaw();
  rows.push(['hash', t('Цифры и сроки права'), `${nums.length} ${I18N.plural(nums.length, ['вопрос', 'вопроса', 'вопросов'])} · ${t('выучено {0} из {1}', [knownOf(nums), nums.length])}`, 'numbers']);
  const doneN = Object.values(P.path?.done || {}).filter(Boolean).length;
  rows.push(['compass', t('Мой путь'), PATH_STEPS_HINT(doneN), 'path']);
  rows.push(['calendar', t('День экзамена'), t('как проходит тест и что взять с собой'), 'brief']);
  rows.forEach(([ico, title, hint, target]) => {
    const row = el('button', 'mode-row');
    row.innerHTML = `<span class="mode-ico" aria-hidden="true">${icon(ico)}</span><span class="mode-body"><b>${esc(title)}</b><span class="note">${esc(hint)}</span></span><span class="mode-chevron" aria-hidden="true">${icon('chevron')}</span>`;
    row.dataset.key = 'mat:' + target;
    row.onclick = () => {
      backNav = 'materials';
      if (target === 'brief') { openBrief = true; nav = 'exam'; } else nav = target;
      render();
    };
    list.append(row);
  });
  wrap.append(list);
  return wrap;
}

/* ------------------------------ ХРОНОЛОГИЯ -------------------------------- */
// Лента дат из пояснений к истории (www/data/timeline.js): по эпохам-разделам банка, тап открывает вопрос.
// первое предложение пояснения; точка после сокращения (до н. э., XI в., 5 тыс., св. Нино) — не конец
const ABBR = /(?:^|[\s(«„])(?:н|э|г|гг|в|вв|св|тыс|млн|т|ст|им|ок|ср|кон|нач|пол|c|cf|St|Dr|Mr|vs|e\.g|i\.e|ca)$/i;
function firstSentence(text) {
  const s = String(text);
  const re = /[.!?]+(?=\s|$)/g; let m;
  while ((m = re.exec(s))) {
    if (ABBR.test(s.slice(0, m.index))) continue;
    const f = s.slice(0, m.index + m[0].length);
    return f.length > 170 ? f.slice(0, 168).trimEnd() + '…' : f;
  }
  return s.length > 170 ? s.slice(0, 168).trimEnd() + '…' : s;
}
function screenTimeline() {
  const wrap = el('div', 'view-inner');
  wrap.append(backBtn());
  wrap.append(el('h1', null, t('Хронология истории')));
  wrap.append(el('p', 'muted', t('Даты из пояснений к 200 вопросам истории. Нажми строку, чтобы открыть вопрос; выучено — значит вопрос дошёл до уровня 3.')));
  const lang = transLang();
  const groups = new Map();
  TIMELINE.forEach(e => { const q = byKey.get(e.key); if (!q) return; if (!groups.has(q.section)) groups.set(q.section, []); groups.get(q.section).push({ e, q }); });
  for (const [sec, items] of groups) {
    const qs = items.map(x => x.q);
    const known = knownOf(qs);
    const c = el('section', 'card');
    const head = el('div', 'tl-head');
    head.append(el('h2', 'h3', esc(trSection(qs[0]))));
    head.append(el('span', `badge ${known === qs.length ? 'ok' : ''}`, `${known}/${qs.length}`));
    head.lastChild.setAttribute('aria-label', t('Выучено {0} из {1}', [known, qs.length]));
    c.append(head);
    const ol = el('ol', 'tl'); ol.setAttribute('role', 'list');
    items.forEach(({ e, q }) => {
      const cd = card(q);
      const li = el('li', 'tl-item' + (cd.box >= D.KNOWN_BOX ? ' known' : cd.seen > 0 ? ' seen' : ''));
      const text = trExplanation(q) ? firstSentence(trExplanation(q)) : trQuestion(q);
      const b = el('button', 'tl-row', `<span class="tl-date">${esc(e.label[lang] || e.label.ru)}</span><span class="tl-text">${esc(text)}</span>${icon('chevron')}`);
      b.setAttribute('aria-label', `${e.label[lang] || e.label.ru}: ${trQuestion(q)}`);
      b.onclick = () => openQuestion(q);
      li.append(b); ol.append(li);
    });
    c.append(ol);
    const due = qs.filter(q => card(q).seen > 0 && isDue(q)).length, wrongN = qs.filter(q => card(q).wrong > 0).length;
    const go = el('button', 'btn ghost small', t('Тренировать эпоху · {0}', [qs.length]));
    go.dataset.key = 'tl:' + sec;
    go.onclick = () => { const mode = due ? 'plan' : wrongN ? 'mistakes' : 'all'; if (!startStudy('history', sec, mode)) startStudy('history', sec, 'all'); };
    c.append(go);
    wrap.append(c);
  }
  return wrap;
}

/* ------------------------------ СТАТИСТИКА -------------------------------- */
function screenStats() {
  const wrap = el('div', 'view-inner');
  const back = el('button', 'link-btn back', `‹ ${t('Обзор')}`);
  back.onclick = () => { nav = 'home'; render(); };
  wrap.append(back);
  wrap.append(el('h1', null, t('Статистика по разделам')));
  wrap.append(el('p', 'muted', t('Учи там, где точность ниже 80% — экзаменационные 30 вопросов берутся из этих же 600 без изменений. Нажми на раздел, чтобы сразу его учить.')));

  SUBJECTS.forEach(s => {
    const c = el('div', 'card');
    c.append(el('h2', null, `${subjName(s)} <span class="muted ka">${subjSub(s)}</span>`));
    const list = el('ul', 'rows'); list.setAttribute('role', 'list');
    sectionsOf(s.id).forEach(sec => {
      const qs = bySubject(s.id).filter(q => q.section === sec);
      const seen = qs.filter(q => card(q).seen > 0);
      const right = seen.reduce((a, q) => a + card(q).right, 0);
      const tries = seen.reduce((a, q) => a + card(q).right + card(q).wrong, 0);
      const acc = pct(right, tries);
      const due = qs.filter(q => card(q).seen > 0 && isDue(q)).length;
      const wrongN = qs.filter(q => card(q).wrong > 0).length;
      const cls = !seen.length ? '' : acc >= 80 ? 'ok' : acc >= 65 ? 'warn' : 'no';
      // название раздела — кнопка: режим подбирается по состоянию раздела
      const secName = trSection(qs[0]);
      const go = el('button', 'link-btn name', `${esc(secName)} ${icon('chevron')}`);
      go.setAttribute('aria-label', t(`Учить раздел «{0}»`, [secName]));
      go.onclick = () => {
        const mode = due ? 'plan' : wrongN ? 'mistakes' : 'all';
        if (!startStudy(s.id, sec, mode)) startStudy(s.id, sec, 'all');
      };
      const vals = el('span', 'vals', `<span class="v"><b>${seen.length}/${qs.length}</b> ${t('пройдено')}</span><span class="v">${seen.length ? `<span class="badge ${cls}">${acc}%</span>` : '<b>—</b>'} ${t('точность')}</span><span class="v"><b>${due}</b> ${t('к повтору')}</span>`);
      // одна составная полоса: выучено / начато / не открыто — видно раньше цифр
      const kn = qs.filter(q => card(q).box >= D.KNOWN_BOX).length;
      const sb = el('div', 'stack-bar');
      sb.setAttribute('role', 'img');
      sb.setAttribute('aria-label', t('выучено {0} из {1}', [kn, qs.length]));
      sb.innerHTML = `<i class="k" style="width:${kn / qs.length * 100}%"></i><i class="s" style="width:${(seen.length - kn) / qs.length * 100}%"></i>`;
      const li = el('li'); li.append(go, sb, vals); list.append(li);
    });
    c.append(list);
    wrap.append(c);
  });

  // достижения — тихие, без прогресс-баров и уведомлений в системе
  const bl = D.badges(P, badgeExtra());
  const bc = el('div', 'card');
  bc.append(el('h2', 'h3', t('Достижения {0} из {1}', [bl.filter(b => b.earned).length, bl.length])));
  const grid = el('ul', 'badges'); grid.setAttribute('role', 'list');
  bl.forEach(b => {
    const [ico, title, desc] = BADGE_META[b.id] || ['·', b.id, ''];
    const li = el('li', 'badge-item' + (b.earned ? ' earned' : ''), `<span class="bico" aria-hidden="true">${ico}</span><span class="btxt"><b>${esc(t(title))}</b><span class="note">${esc(t(desc))}</span></span>`);
    li.setAttribute('aria-label', `${t(title)} — ${b.earned ? t('получено') : t('ещё нет')}`);
    grid.append(li);
  });
  bc.append(grid);
  wrap.append(bc);

  const leech = QUESTIONS.filter(isLeech).sort((a, b) => card(b).wrong - card(a).wrong).slice(0, 15);
  const c = el('div', 'card');
  c.append(el('h2', 'h3', t(`Проблемные вопросы ({0})`, [QUESTIONS.filter(isLeech).length])));
  if (!leech.length) c.append(el('p', 'muted', t('Пока пусто — сюда попадают вопросы с 3+ ошибками.')));
  leech.forEach(q => {
    c.append(el('div', 'note', `<b>${card(q).wrong}×</b> ${subjName(SUBJ[q.subject])} · ${esc(trQuestion(q).slice(0, 90))}…`));
  });
  wrap.append(c);
  return wrap;
}

/* ----------------------------- НАПОМИНАНИЕ -------------------------------- */
const capNotif = () => window.Capacitor?.Plugins?.LocalNotifications;
const REMINDER_ID = 1;
// Расписание пересоздаём при каждом запуске: текст зависит от языка
// интерфейса, а после переустановки плагин ничего не помнит.
async function syncReminder() {
  const n = capNotif(); if (!n) return;
  try {
    const at = P.settings.reminder;
    if (!at) { await n.cancel({ notifications: [{ id: REMINDER_ID }] }); return; }
    if ((await n.checkPermissions()).display !== 'granted') return;
    // без предварительной отмены: schedule с тем же id заменяет уведомление, а пара
    // cancel→schedule при уходе в фон могла оборваться после первой половины
    const [hour, minute] = at.split(':').map(Number);
    // текст по делу: сколько карточек ждёт; обновляется при каждом открытии и уходе в фон
    const dueQs = QUESTIONS.filter(q => card(q).seen > 0 && isDue(q));
    const due = dueQs.length;
    const body = due > 0
      ? t('К повтору {0} {1} — 15 минут хватит.', [due, I18N.plural(due, ['вопрос', 'вопроса', 'вопросов'])])
      : t('15 минут сегодня — и экзамен ближе. Новые вопросы ждут.');
    // в развёрнутом виде — один из вопросов к повтору: тап открывает именно его
    const pick = (dueQs.length ? dueQs : QUESTIONS.filter(isNew))[dayNum(today()) % Math.max(1, (dueQs.length ? dueQs : QUESTIONS.filter(isNew)).length)];
    await n.schedule({ notifications: [{
      id: REMINDER_ID,
      title: t('Пора повторить вопросы'),
      body,
      ...(pick ? { largeBody: `${pick.questionKa}\n${trQuestion(pick)}`, summaryText: body, extra: { qKey: qKey(pick) } } : {}),
      schedule: { on: { hour, minute }, allowWhileIdle: false },
      smallIcon: 'ic_stat_notify',
    }] });
  } catch (e) { console.warn('reminder', e); }
}
// Накануне экзамена (id 3): одно уведомление в 19:00 за день до даты — что взять и как устроен тест
const EVE_ID = 3;
async function syncExamEve() {
  const n = capNotif(); if (!n) return;
  try {
    const ex = P.settings.examDate;
    // ставится заранее на 19:00 накануне (schedule с тем же id заменяет); отменяем только если даты
    // нет или напоминания выключены — уже доставленное на Android не снимаем с панели
    if (!ex || !P.settings.reminder) { await n.cancel({ notifications: [{ id: EVE_ID }] }); return; }
    const [y, m, d] = ex.split('-').map(Number);
    const at = new Date(y, m - 1, d - 1, 19, 0, 0, 0);
    if (at.getTime() <= Date.now()) return;
    if ((await n.checkPermissions()).display !== 'granted') return;
    await n.schedule({ notifications: [{
      id: EVE_ID,
      title: t('Завтра экзамен'),
      body: isRestore()
        ? t('10 вопросов по языку, 20 минут, порог 7/10. Документ, удостоверяющий личность, и памятку — с собой, прийти за 15 минут. Сегодня только повторение.')
        : t('30 вопросов, три блока по 20 минут, порог 7/10 в каждом. Документ, удостоверяющий личность, и памятку — с собой, прийти за 15 минут. Сегодня только повторение.'),
      schedule: { at, allowWhileIdle: false },
      smallIcon: 'ic_stat_notify',
    }] });
  } catch (e) { console.warn('eve', e); }
}
// Вечерний «спасатель серии» (id 2): ставится при уходе в фон, если сегодня ещё не
// занимались и серия ≥ 3; снимается первым ответом за день. Одноразовый, на 21:30.
const SAVER_ID = 2;
async function syncStreakSaver() {
  const n = capNotif(); if (!n) return;
  try {
    const streak = liveStreak();
    const now = new Date(), at = new Date(); at.setHours(21, 30, 0, 0);
    // сегодня уже занимались или вечер прошёл — ставим на завтра: главный случай потери серии —
    // день, когда приложение вообще не открыли; первый ответ завтра снимет уведомление
    if (doneToday() > 0 || now >= at) at.setDate(at.getDate() + 1);
    if (streak < 3 || !P.settings.reminder) { await n.cancel({ notifications: [{ id: SAVER_ID }] }); return; }
    if ((await n.checkPermissions()).display !== 'granted') return;
    await n.schedule({ notifications: [{
      id: SAVER_ID,
      title: t('Серия под угрозой'),
      body: t('{0} {1} подряд — пять вопросов сохранят серию.', [streak, I18N.plural(streak, ['день', 'дня', 'дней'])]),
      schedule: { at, allowWhileIdle: false },
      smallIcon: 'ic_stat_notify',
    }] });
  } catch (e) { console.warn('saver', e); }
}
function cancelStreakSaver() { capNotif()?.cancel({ notifications: [{ id: SAVER_ID }] }).catch(() => {}); }
// тап по уведомлению с вопросом открывает этот вопрос (если нет идущей сессии)
function listenNotifications() {
  const n = capNotif(); if (!n) return;
  n.addListener('localNotificationActionPerformed', ev => {
    const k = ev?.notification?.extra?.qKey;
    if (k && byKey.has(k) && !session) openQuestion(byKey.get(k));
  });
}
async function setReminder(at) {
  const n = capNotif();
  if (at && n) {
    const perm = await n.requestPermissions();
    if (perm.display !== 'granted') { toast(t('Уведомления запрещены — разреши их в настройках системы')); at = null; }
  }
  P.settings.reminder = at; save();
  await syncReminder();
  render();
}

/* ------------------------------- НАСТРОЙКИ -------------------------------- */
function screenSettings() {
  const wrap = el('div', 'view-inner');
  wrap.append(el('h1', null, t('Настройки')));
  // экран собран по группам: языки, занятие, экзамен, уведомления, оформление, данные, о приложении
  const card = title => { const c = el('div', 'card'); c.append(el('h2', 'h3', t(title))); wrap.append(c); return c; };
  const sub = (c, title, hint) => { c.append(el('h3', 'sub', t(title))); if (hint) c.append(el('p', 'muted', t(hint))); };
  const seg = (items, current, onPick) => {
    const g = el('div', 'seg');
    items.forEach(([id, label]) => {
      const b = el('button', null, label);
      b.setAttribute('aria-pressed', String(current === id));
      b.onclick = () => onPick(id);
      g.append(b);
    });
    return g;
  };
  const set = (key, v, after) => { P.settings[key] = v; save(); render(); if (after) after(); };

  // --- языки ---
  const L = card('Языки');
  sub(L, 'Язык интерфейса');
  // язык перевода следует за интерфейсом (грузинского перевода нет — вопросы и так
  // на грузинском); отдельным переключателем его можно вернуть
  const langSeg = seg(I18N.langs, P.settings.uiLang, id => { P.settings.uiLang = id; if (id !== 'ka') P.settings.transLang = id; save(); render(); syncReminder(); });
  [...langSeg.querySelectorAll('button')].forEach((b, i) => { b.lang = I18N.langs[i][0]; });
  L.append(langSeg);
  sub(L, 'Язык вопросов', 'На экзамене всё только по-грузински, русской версии нет. Двигайся к режиму «только KA».');
  L.append(seg(displayModes(), P.settings.display, id => set('display', id)));
  if (hasEnglishBank() || hasUkBank()) {
    sub(L, 'Язык перевода', 'На каком языке показывать перевод вопросов и объяснения.');
    const trLangs = [['ru', 'Русский'], ...(hasUkBank() ? [['uk', 'Українська']] : []), ...(hasEnglishBank() ? [['en', 'English']] : [])];
    const trSeg = seg(trLangs, transLang(), id => set('transLang', id));
    [...trSeg.querySelectorAll('button')].forEach((b, i) => { b.lang = trLangs[i][0]; });
    L.append(trSeg);
  }

  // --- занятие ---
  const S = card('Занятие');
  sub(S, 'Предмет по умолчанию');
  S.append(seg(SUBJECTS.map(x => [x.id, subjName(x)]), P.settings.subject, id => set('subject', id)));
  const shuf = el('label', 'row', t(`<input type="checkbox" {0}> Перемешивать варианты ответов`, [P.settings.shuffle ? 'checked' : '']));
  shuf.querySelector('input').onchange = e => { P.settings.shuffle = e.target.checked; save(); };
  S.append(shuf);
  const np = el('label', 'row', t('Новых вопросов в день: '));
  const inp = el('input'); inp.type = 'number'; inp.min = 10; inp.max = 200; inp.value = P.settings.newPerDay; inp.style.width = '84px';
  inp.setAttribute('aria-label', t('Новых вопросов в день'));
  inp.onchange = () => { P.settings.newPerDay = Math.max(10, Math.min(200, +inp.value || 40)); save(); awardGoal(); };
  np.append(inp); S.append(np);
  sub(S, 'Размер текста вопросов');
  S.append(seg([[1, t('Обычный')], [1.15, t('Крупный')], [1.3, t('Очень крупный')]], P.settings.textScale, v => set('textScale', v)));
  sub(S, 'Пояснение после ответа');
  S.append(seg([['auto', t('Сразу')], ['button', t('По кнопке «Почему?»')], ['off', t('Не показывать')]], P.settings.explain, v => set('explain', v)));
  sub(S, 'Скорость озвучки');
  S.append(seg([[0.7, t('Медленно')], [0.85, t('Обычная')], [1, t('Быстро')]], P.settings.ttsRate, v => set('ttsRate', v)));

  // --- экзамен ---
  const E = card('Экзамен');
  sub(E, 'Процедура', 'При восстановлении гражданства сдаётся только язык: история и право уходят с главной и из экзамена.');
  E.append(seg([['full', t('Обычная (три предмета)')], ['restore', t('Восстановление (только язык)')]], P.settings.procedure, v => {
    P.settings.procedure = v;
    if (v === 'restore') P.settings.subject = 'language';
    save(); render();
  }));
  sub(E, 'Дата экзамена', 'От неё считается дневная норма новых вопросов.');
  const dateRow = el('div', 'row');
  const dateInp = el('input');
  dateInp.type = 'date';
  dateInp.setAttribute('aria-label', t('Дата экзамена'));
  dateInp.value = P.settings.examDate || '';
  dateInp.onchange = () => {
    P.settings.examDate = dateInp.value || null;
    if (dateInp.value) {
      const newLeft = QUESTIONS.filter(isNew).length;
      P.settings.newPerDay = D.planDailyNew(newLeft, dateInp.value, today(), P.settings.newPerDay);
      toast(t(`Норма: {0} {1} в день`, [P.settings.newPerDay, I18N.plural(P.settings.newPerDay, ['новый вопрос', 'новых вопроса', 'новых вопросов'])]));
    }
    save(); awardGoal(); syncExamEve(); render();
  };
  dateRow.append(dateInp);
  if (P.settings.examDate) {
    const clear = el('button', 'btn ghost small', t('Убрать'));
    clear.onclick = () => { P.settings.examDate = null; save(); syncExamEve(); render(); };
    dateRow.append(clear);
  }
  E.append(dateRow);

  // --- уведомления и отклик ---
  const N = card('Уведомления и отклик');
  if (capNotif()) {
    sub(N, 'Напоминание', 'Одно уведомление в день в выбранное время. Работает без интернета, выключено по умолчанию.');
    const rrow = el('div', 'row');
    const lab = el('label', 'row', t(`<input type="checkbox" {0}> Напоминать каждый день`, [P.settings.reminder ? 'checked' : '']));
    const time = el('input'); time.type = 'time'; time.value = P.settings.reminder || '20:00';
    time.setAttribute('aria-label', t('Время напоминания'));
    time.disabled = !P.settings.reminder;
    lab.querySelector('input').onchange = e => setReminder(e.target.checked ? (time.value || '20:00') : null);
    time.onchange = () => { if (P.settings.reminder && time.value) setReminder(time.value); };
    rrow.append(lab, time);
    N.append(rrow);
    if (P.settings.reminder) {
      // переключатель включён, а разрешение отозвано в системе — уведомление не придёт
      const warn = el('p', 'note'); N.append(warn);
      capNotif().checkPermissions().then(pm => { if (pm?.display !== 'granted') { warn.className = 'verdict no'; warn.textContent = t('Система запретила уведомления — разреши их в настройках телефона, иначе напоминание не придёт.'); } }).catch(() => {});
    }
  }
  sub(N, 'Вибрация', window.Capacitor?.Plugins?.Haptics ? null : 'Работает в приложении на телефоне.');
  N.append(seg([['all', t('Везде')], ['results', t('Только результат')], ['off', t('Выключена')]], P.settings.haptics, v => set('haptics', v)));

  // --- оформление ---
  const T = card('Оформление');
  sub(T, 'Тема');
  T.append(seg([['system', t('Как в системе')], ['light', t('Светлая')], ['dark', t('Тёмная')]], P.settings.theme, v => set('theme', v)));
  sub(T, 'Анимации');
  T.append(seg([['system', t('Как в системе')], ['reduced', t('Меньше движения')]], P.settings.motion, v => set('motion', v)));

  // --- данные ---
  const Dc = card('Данные');
  Dc.append(el('p', 'muted', capFs()
    ? t('Прогресс хранится на устройстве и попадает в резервную копию Android. Выгрузка ниже — для переноса вручную.')
    : store.ok
      ? t('Прогресс хранится в этом браузере. Выгружай файл перед сменой устройства или чисткой данных.')
      : t('Это окно блокирует локальное хранилище — обязательно выгружай прогресс в файл.')));
  const row = el('div', 'row actions-grid');
  const exp = el('button', 'btn ghost', t('Выгрузить в файл'));
  exp.onclick = async () => {
    const json = JSON.stringify(P, null, 2);
    const name = `geo-trainer-progress-${today()}.json`;
    const fs = capFs(), share = window.Capacitor?.Plugins?.Share;
    if (fs && share) {
      // в WebView «скачивание» не работает — отдаём файл через системный шэринг
      try {
        const r = await fs.writeFile({ path: name, directory: 'CACHE', encoding: 'utf8', data: json });
        await share.share({ title: t('Прогресс тренажёра'), url: r.uri, dialogTitle: t('Сохранить прогресс') });
      } catch { /* пользователь закрыл шэринг — не ошибка */ }
      return;
    }
    download(new Blob([json], { type: 'application/json' }), name);
  };
  const impLabel = el('label', 'btn ghost', t('Загрузить из файла'));
  const imp = el('input'); imp.type = 'file'; imp.accept = 'application/json'; imp.style.display = 'none';
  imp.onchange = async () => {
    const f = imp.files[0]; if (!f) return;
    imp.value = ''; // тот же файл можно выбрать повторно
    if (f.size > 4 * 1024 * 1024) { toast(t('Файл слишком большой для прогресса')); return; }
    let data = null;
    try { data = JSON.parse(await f.text()); } catch { data = null; }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.srs) { toast(t('Не похоже на файл прогресса')); return; }
    // импорт заменяет всё; терять можно не только ответы, но и закладки, дату экзамена,
    // напоминание — спрашиваем всех, кто уже прошёл онбординг
    if (P.settings.onboarded && !await ask(t('Заменить текущий прогресс данными из файла? Текущий будет потерян.'), t('Заменить'))) return;
    P = normalizeProgress(data);
    pruneToBank();
    P.exams = P.exams.slice(-100);
    session = null; persistSession(); // старая сессия ссылается на прежний прогресс
    save(); flushProgress(); checkBadges(true); render(); syncReminder(); toast(t('Прогресс загружен'));
  };
  impLabel.append(imp);
  row.append(exp, impLabel);
  Dc.append(row);
  const row2 = el('div', 'row actions-grid');
  const resetStats = el('button', 'btn ghost', t('Сбросить статистику'));
  resetStats.onclick = async () => {
    if (await ask(t('Обнулить серию, счётчики и историю попыток? Карточки и закладки останутся.'), t('Обнулить'))) {
      const votes = P.stats.votes; // голоса за функции — не статистика
      P.stats = { ...blankProgress().stats, votes }; P.exams = [];
      save(); flushProgress(); checkBadges(true); render();
    }
  };
  const reset = el('button', 'btn danger', t('Сбросить всё'));
  reset.onclick = async () => {
    if (await ask(t('Удалить весь прогресс? Восстановить будет нельзя.'), t('Удалить'))) {
      P = blankProgress(); session = null; persistSession(); save(); flushProgress(); checkBadges(true); render(); syncReminder();
    }
  };
  row2.append(resetStats, reset);
  Dc.append(row2);

  // --- о приложении ---
  const info = card('О приложении');
  sub(info, 'Формат экзамена');
  info.append(el('p', 'muted', t('30 вопросов: по 10 на грузинский язык, историю Грузии и основы права. 20 минут на блок, час целиком, порог 7/10 в каждом блоке. Первая попытка бесплатна, последующие — 40 GEL, результат действует год.')));
  sub(info, 'Источник вопросов');
  info.append(el('p', 'muted', t('Банк из 600 вопросов (по 200 на предмет) опубликован Агентством развития государственных сервисов Грузии, редакция от 1 мая 2024. Первоисточник — sda.gov.ge.') + ' ' + t('Ключи всех 600 вопросов сверены с PDF агентства ({0}).', [fmtDate(BANK_VERIFIED)])));
  sub(info, 'Переводы и пояснения');
  info.append(el('p', 'muted', t('Вопросы и ключи — агентства. Переводы вопросов и пояснения к ответам сделаны автором приложения с помощью ИИ: пояснения по праву опираются на статьи Конституции, по истории и языку — проверены второй моделью по ключу и источникам. Это помощь в запоминании, а не официальный комментарий; заметили неточность — напишите.')));
  info.append(el('p', 'note', t('Приложение неофициальное: оно не связано с Агентством развития государственных сервисов и не представляет государственные органы Грузии. Результат экзамена не гарантируется.')));
  info.append(el('p', 'note', t(`Вопросов загружено: {0}. Уровни повторения (дни): {1}.`, [QUESTIONS.length, BOX_INTERVALS.join(' · ')])));
  // политика опубликована на сайте (та же, что указана в магазинах); открывается во внешнем браузере
  const pp = el('a', 'link-btn', `${t('Политика конфиденциальности')} ${icon('chevron')}`);
  pp.href = PRIVACY_URL + ({ en: 'en/', uk: 'uk/' }[I18N.lang] || ''); pp.target = '_blank'; pp.rel = 'noopener';
  info.append(pp);

  // Обратная связь: письмо автору с уже заполненной темой и версией — чтобы
  // по письму можно было что-то сделать, а не переспрашивать.
  sub(info, 'Обратная связь', 'Нашли ошибку в вопросе или есть идея — напишите, отвечу.');
  const mail = el('a', 'btn ghost', `${icon('mail')} ${t('Написать автору')}`);
  const mailto = ver => 'mailto:' + AUTHOR_EMAIL
    + '?subject=' + encodeURIComponent(t('Тренажёр гражданства: обратная связь'))
    + '&body=' + encodeURIComponent(`\n\n—\n${diagnostics(ver)}`);
  mail.href = mailto(appVersion());
  const copyD = el('button', 'link-btn small', t('Скопировать диагностику'));
  copyD.onclick = async () => { try { await navigator.clipboard?.writeText(diagnostics(appVersion())); toast(t('Скопировано')); } catch { toast(t('Не удалось скопировать')); } };
  // в приложении точная версия и номер сборки — от нативного слоя
  capApp?.getInfo?.().then(i => { if (i?.version) mail.href = mailto(`${i.version} (${i.build})`); }).catch(() => {});
  info.append(mail);
  info.append(copyD);
  info.append(el('p', 'note', t('Версия {0}', [appVersion()])));
  return wrap;
}

const BANK_VERIFIED = '2026-09-03'; // tools/verify-keys.py по PDF sda.gov.ge
const STORE_URL = 'https://play.google.com/store/apps/details?id=ge.citizenship.trainer.plus';
const PRIVACY_URL = 'https://zuko90-sys.github.io/citizenship-trainer/privacy/'; // сайт: tools/publish-site.sh
// Оценка в сторе: системный диалог (Play In-App Review / StoreKit), не чаще раза на событие;
// только в приятный момент — первый сданный пробный и «Сдал» в «Моём пути».
function requestReview(kind) {
  const r = window.Capacitor?.Plugins?.InAppReview;
  if (!r || P.stats.reviewAsked?.[kind]) return;
  (P.stats.reviewAsked ||= {})[kind] = today(); save();
  r.requestReview().catch(() => {});
}
// ссылка на Play уместна только на Android: на iOS и в вебе — текст без ссылки (в App Store ещё нет)
const storeLink = () => (window.Capacitor?.getPlatform?.() === 'android' ? ` ${STORE_URL}` : '');
const tellOthersText = kind => (kind === 'passed'
  ? t('Сдал экзамен на гражданство Грузии — готовился в бесплатном тренажёре მოქალაქეობა (без рекламы, офлайн).') + storeLink()
  : t('Сдал пробный экзамен в бесплатном тренажёре на гражданство Грузии (მოქალაქეობა) — без рекламы, офлайн.') + storeLink());
const AUTHOR_EMAIL = 'zurabgedenidze90@gmail.com';
// версия — из параметра ?v= у скрипта (его подставляет npm run version:sync)
const appVersion = () => (document.querySelector('script[src*="app.js"]')?.src.match(/[?&]v=([^&]+)/) || [])[1] || 'dev';

/* ------------------------------- РЕНДЕР ----------------------------------- */
// Иконки статус-бара красим под активную тему: на светлом фоне тёмные, на
// тёмном — светлые. Без этого при смене темы в приложении часы и значки
// сливаются с фоном (контент рисуется под статус-баром, edge-to-edge).
let lastBarStyle = null;
function syncStatusBar(theme) {
  const bar = window.Capacitor?.Plugins?.StatusBar;
  if (!bar) return;
  // Шапка всегда зелёная, поэтому иконки статус-бара всегда светлые.
  // Исключение — onboarding: шапка скрыта, сверху фон страницы.
  const onboarding = !P.settings.onboarded;
  const style = onboarding ? (theme === 'dark' ? 'DARK' : 'LIGHT') : 'DARK';
  if (style === lastBarStyle) return;
  lastBarStyle = style;
  bar.setStyle({ style }).catch(() => {});
}

function render() {
  applyUiLang();
  document.querySelectorAll('.tab .lbl').forEach(l => { l.textContent = t(l.dataset.ru); });
  document.querySelectorAll('[data-aria-ru]').forEach(n => { n.setAttribute('aria-label', t(n.dataset.ariaRu)); });
  const theme = activeTheme();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--q-scale', String(P.settings.textScale || 1));
  document.documentElement.classList.toggle('reduce-motion', P.settings.motion === 'reduced');
  syncStatusBar(theme);

  // до конца onboarding прячем шапку и навигацию — на экране только один шаг
  const onboarding = !P.settings.onboarded;
  document.body.classList.toggle('onboarding-mode', onboarding);
  document.body.classList.toggle('in-session', !!session && !(session.kind === 'exam' && session.finished));
  if (onboarding) {
    // нажатая кнопка (язык, процедура) после перерисовки получает фокус обратно — по data-key
    const key = document.activeElement?.dataset?.key;
    view.replaceChildren();
    view.append(screenOnboarding());
    if (key) view.querySelector(`[data-key="${key}"]`)?.focus({ preventScroll: true });
    else window.scrollTo({ top: 0, behavior: 'instant' });
    return;
  }

  document.getElementById('streakVal').textContent = liveStreak();
  const sub = SUBJ[P.settings.subject];
  const inSession = document.body.classList.contains('in-session');
  // словомарка მოქალაქეობა статична (index.html); подпись — название и текущий предмет
  document.getElementById('brandSub').textContent = t('Тренажёр на гражданство'); // предмет — на экранах, в шапке он обрезался
  void sub; void inSession;
  document.querySelectorAll('.tab').forEach(tab => {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(tab.dataset.nav === ({ path: 'materials', numbers: 'materials', grammar: 'materials', timeline: 'materials', stats: 'home' }[nav] || nav)));
  });

  // Тот же экран (переключатель в настройках, тема, закладка) перерисовываем
  // на месте: без анимации появления и без прыжка наверх — иначе каждое
  // нажатие выглядит как перезагрузка страницы. Анимация остаётся только
  // при смене экрана, начале/конце сессии и переходе к следующему вопросу.
  const screenKey = `${nav}|${session ? `${session.kind}:${session.i}:${session.b ?? ''}:${session.finished ? 'done' : ''}` : ''}`;
  const sameScreen = screenKey === lastScreenKey;
  lastScreenKey = screenKey;
  const keepScroll = renderKeepsScroll || sameScreen;
  renderKeepsScroll = false;
  const prevScroll = window.scrollY;

  // Что было нажато: после перерисовки на месте находим тот же элемент в
  // новом DOM, возвращаем ему фокус и даём «пружину» — так нажатие видно
  // принятым, хотя узел уже другой.
  const active = document.activeElement;
  const wasInView = !!(active && view.contains(active)); // до replaceChildren: потом узел уже отсоединён
  const mark = keepScroll && wasInView
    ? { tag: active.tagName, txt: active.textContent, cls: active.className, key: active.dataset.key || null, label: active.getAttribute('aria-label') } : null;

  const screens = { home: screenHome, study: screenStudy, exam: screenExam, stats: screenStats, settings: screenSettings, path: screenPath, numbers: screenNumbers, grammar: screenGrammar, materials: screenMaterials, timeline: screenTimeline };
  const swap = () => {
    view.replaceChildren();
    view.append(screens[nav]());
    window.scrollTo({ top: keepScroll ? prevScroll : 0, behavior: 'instant' });
    view.querySelector('[data-scroll-here]')?.scrollIntoView({ block: 'start', behavior: 'instant' }); // переход к правилу из вопроса
    if (!mark && wasInView) {
      // экран сменился по кнопке внутри него (например, «Цифры и сроки» или «‹ Учить»):
      // фокус на заголовок нового экрана, иначе он падает на <body>
      const h = view.querySelector('.link-btn.back, h1');
      if (h) { if (h.tagName === 'H1') h.tabIndex = -1; h.focus({ preventScroll: true }); }
    }
    if (mark) {
      const same = [...view.querySelectorAll(mark.tag)];
      // сначала по устойчивому ключу (голос, шаг пути, чип уверенности), потом по тексту
      const again = (mark.key && same.find(e => e.dataset.key === mark.key))
        || (mark.label && same.find(e => e.getAttribute('aria-label') === mark.label))
        || same.find(e => e.textContent === mark.txt && e.className === mark.cls)
        || same.find(e => e.textContent === mark.txt);
      if (again) { again.classList.add('pop'); again.focus({ preventScroll: true }); }
    }
  };

  // Смена экрана — через View Transitions, если WebView умеет: старый экран
  // гаснет, новый въезжает, шапка и вкладки стоят. Направление: вперёд по
  // вопросам — справа, назад — слева, иначе снизу.
  const stepI = session && !session.finished ? session.i : null;
  const forward = stepI != null && lastStepI != null && stepI > lastStepI && sameNavAs(lastScreenNav);
  const back = stepI != null && lastStepI != null && stepI < lastStepI && sameNavAs(lastScreenNav);
  lastStepI = stepI; lastScreenNav = nav;
  const canVT = !keepScroll && typeof document.startViewTransition === 'function' && !reducedMotion();
  view.classList.toggle('no-anim', keepScroll || canVT);
  if (canVT) {
    document.documentElement.classList.toggle('vt-forward', forward);
    document.documentElement.classList.toggle('vt-back', back);
    // Если вкладка скрыта или переход прерван, браузер всё равно вызывает swap,
    // а промис отклоняет InvalidStateError — это не ошибка приложения.
    const vt = document.startViewTransition(swap);
    vt.ready?.catch(() => {});
    vt.finished?.catch(() => {});
    // исключение внутри swap() не доходит до window.onerror — ловим здесь; при штатном
    // InvalidStateError (скрытая вкладка) swap уже отработал и экран не пуст
    vt.updateCallbackDone?.catch(e => { if (!view.childElementCount) showFatal(e); });
  } else {
    swap();
  }
}
let lastStepI = null;
let lastScreenNav = null;
const sameNavAs = prev => prev === nav;
const reducedMotion = () => P.settings.motion === 'reduced' || !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

// Ставится перед перерисовкой, которая не меняет экран целиком (ответ на
// вопрос, закладка): позиция прокрутки тогда сохраняется.
let renderKeepsScroll = false;
let lastScreenKey = null;
const renderInPlace = () => { renderKeepsScroll = true; render(); };

// Исключение при рендере не должно оставлять пользователя с белым экраном:
// прогресс на диске цел, поэтому предлагаем просто перезапустить.
function showFatal(e) {
  window.Capacitor?.Plugins?.SplashScreen?.hide().catch(() => {});
  view.replaceChildren();
  const c = el('div', 'card');
  c.append(el('h2', null, t('Что-то пошло не так')));
  c.append(el('p', 'muted', t('Прогресс сохранён — он не потерян. Попробуй перезапустить приложение.')));
  const btn = el('button', 'btn block', t('Перезапустить'));
  btn.onclick = () => location.reload();
  c.append(btn);
  c.append(el('p', 'note', String(e?.message || e).slice(0, 200)));
  view.append(c);
}
// последняя ошибка — в хранилище: попадает в диагностический блок письма автору
const LASTERR_KEY = KEY + ':lasterr';
function recordError(e) {
  try { store.set(LASTERR_KEY, JSON.stringify({ at: new Date().toISOString().slice(0, 16), msg: String(e?.message || e?.reason?.message || e?.reason || e).slice(0, 160) })); } catch { /* хранилище недоступно */ }
}
window.addEventListener('error', e => { recordError(e); if (!view || view.childElementCount > 0) return; showFatal(e); });
window.addEventListener('unhandledrejection', e => { recordError(e); if (!view || view.childElementCount > 0) return; showFatal(e.reason || e); });

// Диагностика для письма автору: версия, платформа, настройки, статистика использования,
// последняя ошибка — ≤1 КБ, без идентификаторов; текст виден человеку перед отправкой.
function diagnostics(ver) {
  const ua = navigator.userAgent || '';
  const dev = (ua.match(/Android [\d.]+;[^;)]*/) || ua.match(/iPhone OS [\d_]+/) || [])[0] || (window.Capacitor?.getPlatform?.() || 'web');
  let lastErr = null; try { lastErr = JSON.parse(store.get(LASTERR_KEY) || 'null'); } catch { lastErr = null; }
  const st = P.stats;
  return [
    `${t('Версия {0}', [ver])} · ${dev.trim()}`,
    `UI: ${I18N.lang}, ${P.settings.transLang}, ${P.settings.display}, ${P.settings.procedure}, ${P.settings.theme}, x${P.settings.textScale}, ${P.settings.haptics}/${P.settings.motion}`,
    `${t('Использование')}: ${st.answered} ${t('ответов')}, ${st.examsTaken}/${st.examsPassed} ${t('экзаменов')}, ${st.dailyCount || 0} ${t('экзаменов дня')}, ⚡${st.quickBest || 0}, 🔥${liveStreak()}, ❄️${st.freezes || 0}, ${Object.keys(P.notes).length} ${t('заметок')}, ${P.settings.examDate ? t('дата задана') : t('без даты')}, ${P.settings.reminder ? t('напоминание') : t('без напоминания')}`,
    `${t('Интересует')}: ${Object.keys(st.votes || {}).join(', ') || '—'}`,
    lastErr ? `${t('Последняя ошибка')}: ${lastErr.at} ${lastErr.msg}` : '',
  ].filter(Boolean).join('\n').slice(0, 1000);
}

document.querySelectorAll('.tab').forEach(tab => tab.onclick = async () => {
  // повторный тап по активной вкладке — просто наверх, без перерисовки
  if (tab.dataset.nav === nav && !session) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  // быстрый раунд живёт только на своём экране
  if (session && session.kind === 'quick' && tab.dataset.nav !== 'study') { clearInterval(quickTimer); session = null; }
  if (session && session.kind === 'exam' && !session.finished && tab.dataset.nav !== 'exam') {
    if (!await ask(t('Экзамен идёт. Выйти и потерять попытку?'), t('Выйти'))) return;
    clearInterval(timerId); session = null; persistSession();
  }
  nav = tab.dataset.nav; render();
});
window.matchMedia?.('(prefers-color-scheme: dark)')
  ?.addEventListener?.('change', () => { if (loaded && P.settings.theme === 'system') render(); });

// Свайп по вопросу (только касание): влево — дальше, вправо — назад.
// В занятии «дальше» доступно после ответа, как и кнопка.
let swipeStart = null;
view.addEventListener('pointerdown', e => {
  swipeStart = (e.pointerType === 'touch' && session && !session.finished && !session.between)
    ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
}, { passive: true });
view.addEventListener('pointerup', e => {
  const s = swipeStart; swipeStart = null;
  if (!s || !session || session.finished || session.between) return;
  const dx = e.clientX - s.x, dy = e.clientY - s.y;
  if (Date.now() - s.t > 700 || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
  swipeNav(dx < 0 ? 1 : -1);
}, { passive: true });
function swipeNav(dir) {
  if (!session || session.kind === 'quick') return;
  const { q, answers, total } = currentQuestion();
  if (session.kind === 'exam') {
    const to = session.i + dir;
    if (to < 0 || to >= total) return;
    session.i = to; persistSession(); render();
  } else {
    if (dir < 0 || answers.get(qKey(q)) == null) return;
      if (session.i >= total - 1) leaveStudy(); else { session.i++; render(); }
  }
  haptic('select');
}

document.getElementById('themeBtn').onclick = () => {
  P.settings.theme = activeTheme() === 'dark' ? 'light' : 'dark';
  save(); render();
};
document.getElementById('streakBtn').onclick = () => { nav = 'stats'; render(); };
document.addEventListener('keydown', e => {
  if (document.querySelector('.modal-back')) return; // открыт диалог — шорткаты страницы молчат
  if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return; // печатают в поле
  if (!session || (session.kind === 'exam' && session.finished)) return;
  const k = e.key.toLowerCase();
  const map = { a: 0, b: 1, c: 2, d: 3, '1': 0, '2': 1, '3': 2, '4': 3 };
  if (k in map) { document.querySelectorAll('.opt')[map[k]]?.click(); }
  if (k === 'enter' || k === ' ') { document.querySelector('.btn:not(.ghost)')?.click(); }
});

// системная кнопка «Назад» (Capacitor): подтверждение в экзамене,
// возврат на главную с других экранов, сворачивание с главной
const capApp = window.Capacitor?.Plugins?.App;
if (capApp) {
  capApp.addListener('backButton', async () => {
    const openModal = document.querySelector('.modal-back');
    if (openModal) {
      openModal.querySelector('.btn.ghost')?.click(); // закрыть как «Отмена», чтобы resolve-нуть ask()
      return;
    }
    if (session && session.kind === 'exam' && !session.finished) {
      if (await ask(t('Экзамен идёт. Выйти и потерять попытку?'), t('Выйти'))) {
        clearInterval(timerId); session = null; persistSession(); nav = 'home'; render();
      }
      return;
    }
    if (session && session.kind === 'exam' && session.finished) {
      // экран результата: «Назад» просто закрывает его
      session = null; persistSession(); nav = 'home'; render();
      return;
    }
    if (session && session.kind === 'quick') { clearInterval(quickTimer); session = null; nav = 'home'; render(); return; }
    if (session) { leaveStudy(); return; }
    if (nav !== 'home') { nav = 'home'; render(); return; }
    capApp.minimizeApp();
  });
}

// жизненный цикл: при возврате пересчитываем экзаменационные часы,
// при уходе в фон немедленно сбрасываем прогресс на диск
if (capApp) {
  capApp.addListener('appStateChange', ({ isActive }) => {
    if (!loaded) return;
    if (isActive) checkExamClock(); // сам перерисует, только если блок истёк
    else { persistSession(); flushProgress(); }
  });
}
document.addEventListener('visibilitychange', () => {
  if (!loaded) return;
  if (document.hidden) { persistSession(); flushProgress(); syncReminder(); syncStreakSaver(); syncExamEve(); }
  else { checkExamClock(); applySafeArea(); }
});

/* -------------------------------- запуск ---------------------------------- */
// Запуск с ярлыка на иконке: «Повторить» открывает занятие по плану,
// «Экзамен» — экран экзамена. Идущую сессию не трогаем.
function applyShortcut() {
  if (!loaded) return; // страница ещё грузится — boot() применит ярлык сам
  const kind = window.__shortcut;
  window.__shortcut = null;
  window.Capacitor?.Plugins?.Shortcut?.consume?.()?.catch?.(() => {}); // iOS: ярлык обработан, в плагине не держим
  if (!kind || session) return;
  if (kind === 'review') {
    if (!startStudy(P.settings.subject, 'all', 'plan')) { nav = 'study'; render(); }
  } else if (kind === 'exam') {
    nav = 'exam';
    render();
  }
}
window.addEventListener('shortcut', applyShortcut);

/* ------------------------------ ХАПТИКА ----------------------------------- */
// Лёгкий отклик на касание — половина ощущения «плавности» на телефоне.
// Одно место для всех кнопок (перехват клика), плюс осмысленный отклик
// на результат: верно/неверно, экзамен сдан/не сдан.
const haptic = kind => {
  const h = window.Capacitor?.Plugins?.Haptics;
  if (!h) return;
  // настройка: all — везде, results — только верно/неверно и итог экзамена (без праздников), off — никогда
  const mode = P.settings.haptics || 'all';
  if (mode === 'off') return;
  if (mode === 'results' && kind !== 'ok' && kind !== 'error') return;
  try {
    if (kind === 'select') h.selectionChanged();
    else if (kind === 'ok') h.notification({ type: 'SUCCESS' });
    else if (kind === 'error') h.notification({ type: 'ERROR' });
    else if (kind === 'celebrate') h.notification({ type: 'SUCCESS' }); // цель дня, достижение
    else h.impact({ style: kind === 'medium' ? 'MEDIUM' : 'LIGHT' });
  } catch { /* нет вибромотора — молчим */ }
};
document.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return;
  // варианты ответа (.opt) сюда не входят: у них отклик по результату в answer()
  const b = e.target.closest('.seg button, .tab, .mode-row, .btn, .icon-btn, .chip, .link-btn, .qmap-cell');
  if (!b || b.disabled) return;
  haptic(b.matches('.seg button, .tab, .qmap-cell') ? 'select' : 'light');
}, { passive: true });

// Отступы системных панелей: в Android WebView env(safe-area-inset-*) даёт 0,
// нативный слушатель в MainActivity срабатывает до загрузки страницы —
// поэтому при старте (и при возврате в приложение) спрашиваем сами.
async function applySafeArea() {
  const p = window.Capacitor?.Plugins?.SafeArea;
  if (!p) return;
  try {
    const i = await p.get();
    if (!i || !i.known) return;
    const st = document.documentElement.style;
    st.setProperty('--safe-t', `${Math.round(i.top)}px`);
    st.setProperty('--safe-b', `${Math.round(i.bottom)}px`);
    st.setProperty('--safe-l', `${Math.round(i.left)}px`);
    st.setProperty('--safe-r', `${Math.round(i.right)}px`);
  } catch { /* без плагина остаётся env() */ }
}

async function boot() {
  byKey = new Map(QUESTIONS.map(q => [qKey(q), q]));
  await Promise.all([loadProgress(), applySafeArea()]);
  restoreSession();
  listenNotifications();
  if (!store.get(BADGE_KEY)) checkBadges(true); // первый расчёт задним числом — без тостов
  render();
  // iOS: ярлык при холодном старте лежит в плагине Shortcut, пока страница не загрузилась
  try { const r = await window.Capacitor?.Plugins?.Shortcut?.consume?.(); if (r?.type) window.__shortcut = r.type; } catch { /* нет плагина */ }
  applyShortcut(); // ярлык мог сработать до готовности приложения
  // сплэш убираем только когда экран уже отрисован — иначе видна пустая заставка
  window.Capacitor?.Plugins?.SplashScreen?.hide().catch(() => {});
  syncReminder(); syncExamEve();
  registerOffline();
}

// Веб-версия: офлайн через service worker. Не в приложении (там файлы локальные) и не на
// localhost — иначе кэш мешал бы разработке и автопроверкам.
function registerOffline() {
  if (window.Capacitor || !('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// банк вопросов вшит скриптом data/questions.js — единственный источник
if (Array.isArray(window.QUESTIONS_DATA) && window.QUESTIONS_DATA.length) {
  QUESTIONS = window.QUESTIONS_DATA;
  // упавший boot() не должен оставить пользователя с вечным сплэшем
  boot().catch(showFatal);
} else {
  view.innerHTML = t('<div class="card"><b>Не удалось загрузить банк вопросов</b><p class="muted">Файл data/questions.js повреждён или отсутствует — переустановите приложение</p></div>');
}
