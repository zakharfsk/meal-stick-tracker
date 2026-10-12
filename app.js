/* Їжа та стіки - PWA tracker.
 * Sections: helpers · meal plan · storage · backup · actions · render · tabs · history · cloud · pull-to-refresh · boot
 * Local storage (IndexedDB + localStorage mirror) is the source of truth; Firestore syncs on top of it.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const DEF = { wake: "09:30", meals: 4, gap: 120, limit: 4, interval: 3.5 };
  let settings = { ...DEF };
  let today = { meals: [], sticks: [], types: {}, wake: null, sleep: null };
  const TYPES = ["Сніданок", "Обід", "Вечеря", "Перекус"];
  let pendingMealMs = null;
  let lastAdded = null; // timestamp of the row just added, for its entry animation
  let lastStatusCls = null;
  let allDays = {}; // dayKey -> record, every day we know about
  let loadedKey = null; // which day `today` currently holds

  // Every meal (snacks too) counts toward the plan.
  function mainMeals() {
    return today.meals.slice();
  }

  // ---- day key: a day starts at 05:00 so late sticks count for the evening before
  const DAY_SHIFT = 5 * 60;
  function dayKey(d = new Date()) {
    const x = new Date(d.getTime() - DAY_SHIFT * 60000);
    return (
      x.getFullYear() +
      "-" +
      String(x.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(x.getDate()).padStart(2, "0")
    );
  }
  function keyDate(k) {
    const [y, m, d] = k.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function hm(ms) {
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function minsOf(t) {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  }
  function todayAt(mins) {
    const base = keyDate(dayKey());
    const d = new Date(base);
    d.setHours(0, 0, 0, 0);
    d.setMinutes(mins);
    return d.getTime();
  }
  function fmtDur(ms) {
    const m = Math.max(0, Math.ceil(ms / 60000));
    const h = Math.floor(m / 60),
      mm = m % 60;
    return h ? `${h} год ${String(mm).padStart(2, "0")} хв` : `${mm} хв`;
  }

  // ---- meal plan: base from the real wake time (or the setting); each logged meal fills the next slot
  function basePlanFor(rec, k) {
    const dayStart0 = keyDate(k).setHours(0, 0, 0, 0);
    const wakeMin = rec.wake ? Math.round((rec.wake - dayStart0) / 60000) : null;
    const first = (wakeMin !== null && wakeMin < 19 * 60 ? wakeMin : minsOf(settings.wake)) + 30; // a wake logged after 19:00 is ignored for the plan
    const n = settings.meals;
    let step = (+settings.interval || 3.5) * 60;
    const hardLast = 22 * 60;
    if (n > 1 && first + (n - 1) * step > hardLast) step = Math.max(90, (hardLast - first) / (n - 1));
    return Array.from({ length: n }, (_, i) => Math.round(first + i * step));
  }
  function plan() {
    return planFor(today, dayKey());
  }
  function planFor(rec, k) {
    const base = basePlanFor(rec, k);
    const n = base.length;
    const meals = (rec.meals || []).slice().sort((a, b) => a - b);
    if (!meals.length) return base;
    const dayStart = keyDate(k).setHours(0, 0, 0, 0);
    const logged = meals.slice(0, n).map((m) => Math.round((m - dayStart) / 60000));
    if (logged.length >= n) return logged;
    const remaining = n - logged.length;
    let step = n > 1 ? base[1] - base[0] : 0;
    const hardLast = 22 * 60;
    const last = logged[logged.length - 1];
    if (last + remaining * step > hardLast) step = Math.max(90, (hardLast - last) / remaining);
    return logged.concat(Array.from({ length: remaining }, (_, i) => Math.round(last + (i + 1) * step)));
  }

  // ---- storage: IndexedDB (all days kept), localStorage as a last resort
  const DBN = "meal-stick-tracker",
    LS = "bile-sticks-v1";
  let idb = null;
  function openIdb() {
    return new Promise((res, rej) => {
      try {
        const r = indexedDB.open(DBN, 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore("days");
          d.createObjectStore("settings");
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) {
        rej(e);
      }
    });
  }
  function tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = idb.transaction(store, mode);
      const st = t.objectStore(store);
      const r = fn(st);
      t.oncomplete = () => res(r && r.result);
      t.onerror = () => rej(t.error);
    });
  }
  function lsLoad() {
    try {
      return JSON.parse(localStorage.getItem(LS) || "{}");
    } catch {
      return {};
    }
  }
  function lsSave(obj) {
    try {
      localStorage.setItem(LS, JSON.stringify(obj));
    } catch {}
  }

  async function saveToday() {
    rolloverCheck();
    const k = dayKey();
    const rec = {
      meals: today.meals,
      sticks: today.sticks,
      types: today.types,
      wake: today.wake || null,
      sleep: today.sleep || null,
      updatedAt: Date.now(),
    };
    if (idb) {
      try {
        await tx("days", "readwrite", (st) => st.put(rec, k));
      } catch {
        toast("Не вдалося зберегти");
      }
    }
    const all = lsLoad();
    all.days = all.days || {};
    all.days[k] = rec;
    lsSave(all);
    allDays[k] = rec;
    render();
    cloud.pushDay(k, rec);
    cloud.pushPlan();
  }
  async function saveSettings() {
    if (idb) {
      try {
        await tx("settings", "readwrite", (st) => st.put(settings, "main"));
      } catch {}
    }
    settings.updatedAt = Date.now();
    const all = lsLoad();
    all.settings = settings;
    lsSave(all);
    render();
    toast("Збережено");
    cloud.pushSettings();
    cloud.pushPlan();
  }
  function openIdbTimeout(ms) {
    return Promise.race([
      openIdb(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("idb timeout")), ms)),
    ]);
  }
  function applyData(days, st) {
    settings = { ...DEF, ...(st || {}) };
    allDays = days;
    setToday(dayKey());
    render();
  }
  async function loadAll() {
    // 1) localStorage mirror first - synchronous, so the screen is never empty
    const ls = lsLoad();
    applyData(ls.days || {}, ls.settings);
    // 2) IndexedDB (may hang on iOS after a reload - give it a deadline, fall back to the mirror)
    let days = {},
      st = null;
    try {
      idb = await openIdbTimeout(2500);
      const keys = await tx("days", "readonly", (s) => s.getAllKeys());
      const vals = await tx("days", "readonly", (s) => s.getAll());
      keys.forEach((k, i) => (days[k] = vals[i]));
      st = await tx("settings", "readonly", (s) => s.get("main"));
    } catch {
      idb = null;
    }
    if (idb) {
      const lsDays = ls.days || {};
      // merge: a day present only in the mirror is restored into IDB; otherwise IDB wins
      for (const k in lsDays) {
        if (!days[k]) {
          days[k] = lsDays[k];
          try {
            await tx("days", "readwrite", (s) => s.put(lsDays[k], k));
          } catch {}
        }
      }
      applyData(days, st || ls.settings);
      lsSave({ days, settings });
    }
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    } catch {}
  }
  function setToday(k) {
    loadedKey = k;
    const t = allDays[k];
    today = t
      ? {
          meals: [...(t.meals || [])],
          sticks: [...(t.sticks || [])],
          types: { ...(t.types || {}) },
          wake: t.wake || null,
          sleep: t.sleep || null,
        }
      : { meals: [], sticks: [], types: {}, wake: null, sleep: null };
  }
  // a new day (05:00) started while the app was open: switch to it instead of writing into yesterday
  function rolloverCheck() {
    const k = dayKey();
    if (loadedKey !== null && k !== loadedKey) {
      setToday(k);
      lastStatusCls = null;
    }
  }

  // ---- backup
  async function exportJson() {
    let days = allDays;
    if (idb) {
      try {
        const keys = await tx("days", "readonly", (s) => s.getAllKeys());
        const vals = await tx("days", "readonly", (s) => s.getAll());
        days = {};
        keys.forEach((k, i) => (days[k] = vals[i]));
      } catch {}
    }
    const blob = new Blob(
      [JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), settings, days }, null, 2)],
      { type: "application/json" }
    );
    const name = "meal-stick-backup-" + dayKey() + ".json";
    try {
      if (navigator.canShare && window.File) {
        const f = new File([blob], name, { type: "application/json" });
        if (navigator.canShare({ files: [f] })) {
          await navigator.share({ files: [f], title: "Бекап трекера" });
          return;
        }
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }
  async function importJson(file) {
    try {
      const obj = JSON.parse(await file.text());
      if (!obj.days) throw 0;
      for (const k in obj.days) {
        if (idb) await tx("days", "readwrite", (s) => s.put(obj.days[k], k));
      }
      const all = lsLoad();
      all.days = { ...(all.days || {}), ...obj.days };
      if (obj.settings) all.settings = obj.settings;
      lsSave(all);
      if (obj.settings) {
        settings = { ...DEF, ...obj.settings };
        if (idb) await tx("settings", "readwrite", (s) => s.put(settings, "main"));
      }
      await loadAll();
      toast("Імпортовано " + Object.keys(obj.days).length + " днів");
    } catch {
      toast("Файл не схожий на бекап");
    }
  }

  // ---- actions
  function addEvent(kind, ms, type) {
    const arr = kind === "meal" ? today.meals : today.sticks;
    arr.push(ms);
    arr.sort((a, b) => a - b);
    lastAdded = ms;
    if (kind === "meal" && type) today.types[ms] = type;
    const pill = $(kind === "meal" ? "mealCount" : "stickCount");
    pill.classList.remove("bump");
    void pill.offsetWidth;
    pill.classList.add("bump");
    if (kind === "stick" && today.sticks.length > settings.limit)
      toast(`Це ${today.sticks.length}-й стік, ціль ${settings.limit}`);
    saveToday();
  }
  function removeEvent(kind, ms) {
    const arr = kind === "meal" ? today.meals : today.sticks;
    const i = arr.indexOf(ms);
    if (i >= 0) arr.splice(i, 1);
    delete today.types[ms];
    saveToday();
  }
  function customMs() {
    const v = $("customTime").value;
    if (!v) return null;
    return todayAt(minsOf(v) < DAY_SHIFT ? minsOf(v) + 24 * 60 : minsOf(v));
  }

  $("btnMeal").onclick = () => openChooser(Date.now());
  $("btnStick").onclick = () => {
    const s = statusNow();
    if (s.cls === "ok") {
      addEvent("stick", Date.now());
      toast(`Записано. Наступний не раніше ніж через ${fmtDur(settings.gap * 60000)} після їжі.`);
      return;
    }
    $("askTitle").innerHTML = s.cls === "wait" ? "Ще рано" : "Ціль уже вичерпана";
    $("askText").textContent = s.sub;
    $("ask").hidden = false;
    $("askNo").focus();
  };
  $("askNo").onclick = () => {
    $("ask").hidden = true;
  };
  $("askYes").onclick = () => {
    $("ask").hidden = true;
    addEvent("stick", Date.now());
  };
  $("btnMealAt").onclick = () => {
    const m = customMs();
    if (m) openChooser(m);
    else toast("Вкажи час");
  };
  function openChooser(ms) {
    pendingMealMs = ms;
    $("ask").hidden = true;
    const n = today.meals.length,
      total = settings.meals;
    const suggest = n === 0 ? "Сніданок" : n >= total - 1 ? "Вечеря" : n === 1 ? "Обід" : "Перекус";
    $("chooseTime").textContent = hm(ms);
    $("chooseBtns").innerHTML = TYPES.map(
      (t) => `<button data-t="${t}" class="${t === suggest ? "suggest" : ""}">${t}</button>`
    ).join("");
    $("chooseBtns")
      .querySelectorAll("button")
      .forEach(
        (b) =>
          (b.onclick = () => {
            $("choose").hidden = true;
            addEvent("meal", pendingMealMs, b.dataset.t);
          })
      );
    $("choose").hidden = false;
  }
  $("chooseCancel").onclick = () => {
    $("choose").hidden = true;
  };
  $("btnStickAt").onclick = () => {
    const m = customMs();
    if (m) addEvent("stick", m);
    else toast("Вкажи час");
  };
  function setSleepEv(kind, ms) {
    today[kind] = ms;
    lastAdded = ms;
    saveToday();
    toast(kind === "wake" ? "Підйом записано" : "Добраніч");
  }
  document
    .querySelectorAll(".sleep button")
    .forEach((b) => (b.onclick = () => setSleepEv(b.dataset.w, Date.now())));
  $("wakeIn").onchange = (e) => {
    const v = e.target.value;
    if (!v) return;
    setSleepEv("wake", todayAt(minsOf(v) < DAY_SHIFT ? minsOf(v) + 24 * 60 : minsOf(v)));
  };
  $("sleepIn").onchange = (e) => {
    const v = e.target.value;
    if (!v) return;
    setSleepEv("sleep", todayAt(minsOf(v) < DAY_SHIFT ? minsOf(v) + 24 * 60 : minsOf(v)));
  };
  function prevKey(k) {
    const d = keyDate(k);
    d.setDate(d.getDate() - 1);
    return dayKey(new Date(d.getTime() + DAY_SHIFT * 60000 + 60000));
  }
  function sleepHours(k, rec) {
    const pr = allDays[prevKey(k)];
    if (!pr || !pr.sleep || !rec.wake) return null;
    const h = (rec.wake - pr.sleep) / 3600000;
    return h > 0 && h < 20 ? h : null;
  }
  $("sSave").onclick = () => {
    settings = {
      wake: $("sWake").value || DEF.wake,
      meals: +$("sMeals").value || DEF.meals,
      gap: Math.round((+$("sGapH").value || DEF.gap / 60) * 60),
      limit: Math.max(0, +$("sLimit").value),
      interval: +$("sInterval").value || DEF.interval,
    };
    saveSettings();
  };

  // ---- render
  function statusNow() {
    const now = Date.now();
    const lastMeal = today.meals.length ? today.meals[today.meals.length - 1] : null;
    const plans = plan().map(todayAt);
    const nextPlan = plans.find((p) => p > now);
    if (!lastMeal)
      return {
        cls: "wait",
        big: "Спочатку поїж",
        sub: nextPlan
          ? `Стік натщесерце не варто. Перший прийом їжі за планом о ${hm(nextPlan)}.`
          : "Стік натщесерце не варто.",
      };
    const okAt = lastMeal + settings.gap * 60000;
    if (now < okAt)
      return {
        cls: "wait",
        big: `Зачекай ще <span class="timer">${fmtDur(okAt - now)}</span>`,
        sub: `Поїв о ${hm(lastMeal)}, міхур ще спорожнюється. Можна з ${hm(okAt)}.`,
        ring: { from: lastMeal, to: okAt },
      };
    if (today.sticks.length >= settings.limit && settings.limit > 0)
      return {
        cls: "limit",
        big: "Ціль на сьогодні вичерпана",
        sub: `Уже ${today.sticks.length} з ${settings.limit}. Кожен наступний - понад план.`,
      };
    let sub = `Після їжі о ${hm(lastMeal)} минуло ${fmtDur(now - lastMeal)}.`;
    if (nextPlan && nextPlan - now < 45 * 60000) sub += ` Наступна їжа о ${hm(nextPlan)} - встигни до неї.`;
    return { cls: "ok", big: "Можна стік", sub };
  }
  // ---- countdown ring (ticks every second while waiting)
  const RING_C = 2 * Math.PI * 44;
  let ringTimer = null,
    ringWasWaiting = false;
  function fmtClock(ms) {
    const t = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(t / 3600),
      m = Math.floor((t % 3600) / 60),
      sec = t % 60;
    return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
  }
  function ringTick() {
    const s = statusNow();
    const r = $("ring");
    if (s.ring) {
      const now = Date.now(),
        total = s.ring.to - s.ring.from,
        left = s.ring.to - now,
        p = Math.min(1, Math.max(0, (now - s.ring.from) / total));
      r.hidden = false;
      r.classList.remove("done");
      r.classList.toggle("hot", left < 5 * 60000);
      $("ringProg").style.strokeDashoffset = (RING_C * (1 - p)).toFixed(2);
      $("ringMain").textContent = fmtClock(left);
      $("ringSub").textContent = "до стіка";
      ringWasWaiting = true;
      if (!ringTimer) ringTimer = setInterval(ringTick, 1000);
    } else {
      if (ringTimer) {
        clearInterval(ringTimer);
        ringTimer = null;
      }
      if (ringWasWaiting && s.cls === "ok") {
        // just finished: celebrate, then hand over to the text
        ringWasWaiting = false;
        r.hidden = false;
        r.classList.add("done");
        $("ringProg").style.strokeDashoffset = "0";
        $("ringMain").textContent = "✓";
        $("ringSub").textContent = "можна";
        setTimeout(() => {
          r.hidden = true;
          r.classList.remove("done");
        }, 3500);
        render();
        return;
      }
      ringWasWaiting = false;
      if (!r.classList.contains("done")) r.hidden = true;
    }
  }
  // ---- keyed DOM sync: update children in place so nothing re-animates on a routine render
  function syncChildren(parent, items, keyOf, update, create, onRemove) {
    const byKey = new Map();
    for (const el of parent.children) if (el.dataset.key) byKey.set(el.dataset.key, el);
    let prev = null;
    items.forEach((it, i) => {
      const key = keyOf(it, i);
      let el = byKey.get(key);
      const fresh = !el;
      if (fresh) {
        el = create(it);
        el.dataset.key = key;
      } else byKey.delete(key);
      update(el, it, fresh);
      const want = prev ? prev.nextSibling : parent.firstChild;
      if (el !== want) parent.insertBefore(el, want);
      prev = el;
    });
    byKey.forEach((el) => (onRemove ? onRemove(el) : el.remove()));
  }
  const ICON_OF = { meal: "meal", stick: "stick", wake: "sunrise", sleep: "moon" };
  function labelOf(e) {
    return e.k === "meal"
      ? today.types[e.t] || "Їжа"
      : e.k === "stick"
        ? "Стік"
        : e.k === "wake"
          ? "Підйом"
          : "Сон";
  }
  function renderTimeline(ev) {
    syncChildren(
      $("timeline"),
      ev,
      (e) => e.k + "-" + e.t,
      (li, e, fresh) => {
        let note = "";
        if (e.k === "stick") {
          const prev = [...today.meals].reverse().find((m) => m <= e.t);
          note = prev ? `+${fmtDur(e.t - prev)} після їжі` : "натщесерце";
        }
        const cls = e.k + (fresh && e.t === lastAdded ? " new" : "");
        if (li.className !== cls && !li.classList.contains("confirm")) li.className = cls;
        const t = li.querySelector(".t");
        const lab = li.querySelector(".lab");
        const nt = li.querySelector(".note");
        if (t.textContent !== hm(e.t)) t.textContent = hm(e.t);
        if (lab.textContent !== labelOf(e)) lab.textContent = labelOf(e);
        if (nt.textContent !== note) nt.textContent = note;
        const b = li.querySelector("button");
        b.dataset.k = e.k;
        b.dataset.t = e.t;
      },
      (e) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="t"></span><span class="k"><svg class="ic sm"><use href="#i-${ICON_OF[e.k]}"/></svg><span class="lab"></span> <span class="note"></span></span><button aria-label="Видалити"><svg class="ic sm"><use href="#i-trash"/></svg></button>`;
        li.querySelector("button").onclick = onDeleteTap;
        return li;
      },
      (li) => {
        if (li.classList.contains("removing")) return li.remove();
        li.classList.add("removing");
        setTimeout(() => li.remove(), 200);
      }
    );
  }
  function onDeleteTap(ev) {
    ev.stopPropagation();
    const b = ev.currentTarget;
    const li = b.closest("li");
    if (!li.classList.contains("confirm")) {
      $("timeline")
        .querySelectorAll("li.confirm")
        .forEach((x) => cancelConfirm(x));
      li.classList.add("confirm");
      b.innerHTML = "Видалити?";
      b.setAttribute("aria-label", "Підтвердити видалення");
      li._t = setTimeout(() => cancelConfirm(li), 4000);
      return;
    }
    clearTimeout(li._t);
    li.classList.remove("confirm");
    li.classList.add("removing");
    lastAdded = null;
    setTimeout(() => {
      if (b.dataset.k === "wake" || b.dataset.k === "sleep") {
        today[b.dataset.k] = null;
        saveToday();
      } else removeEvent(b.dataset.k, +b.dataset.t);
    }, 180);
  }
  function render() {
    rolloverCheck();
    const s = statusNow();
    const st = $("status");
    st.className = "card status " + s.cls;
    if (s.cls !== lastStatusCls) {
      lastStatusCls = s.cls;
      ["stBig", "stSub"].forEach((id) => {
        const e = $(id);
        e.style.animation = "none";
        void e.offsetWidth;
        e.style.animation = "";
      });
    }
    $("stBig").innerHTML = s.ring ? "Зачекай" : s.big;
    $("stSub").textContent = s.sub;
    ringTick();
    $("mealCount").textContent = `Їжа ${mainMeals().length}/${settings.meals}`;
    $("stickCount").textContent = `Стіки ${today.sticks.length}/${settings.limit}`;
    $("dateLabel").textContent = keyDate(dayKey()).toLocaleDateString("uk-UA", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });

    const now = Date.now();
    const pl = plan();
    let nextMarked = false;
    const doneN = Math.min(today.meals.length, pl.length);
    const chips = pl.map((m, i) => {
      const done = i < doneN;
      let cls = done ? "done" : "";
      if (!done && !nextMarked && todayAt(m) > now - 60 * 60000) {
        cls = "next";
        nextMarked = true;
      }
      return { cls, text: hmFromMin(m) };
    });
    syncChildren(
      $("plan"),
      chips,
      (c, i) => "p" + i,
      (el, c) => {
        el.className = c.cls;
        if (el.textContent !== c.text) el.textContent = c.text;
      },
      () => document.createElement("span")
    );

    if (document.activeElement !== $("wakeIn")) $("wakeIn").value = today.wake ? hm(today.wake) : "";
    if (document.activeElement !== $("sleepIn")) $("sleepIn").value = today.sleep ? hm(today.sleep) : "";
    {
      const sh = sleepHours(dayKey(), today);
      $("sleepNote").textContent = sh
        ? `Спав ${sh.toFixed(1)} год.`
        : today.wake
          ? "Підйом записаний - план їжі рахується від нього."
          : "Відміть підйом - план їжі зсунеться від реального часу.";
    }
    const ev = [
      ...today.meals.map((t) => ({ k: "meal", t })),
      ...today.sticks.map((t) => ({ k: "stick", t })),
      ...(today.wake ? [{ k: "wake", t: today.wake }] : []),
      ...(today.sleep ? [{ k: "sleep", t: today.sleep }] : []),
    ].sort((a, b) => a.t - b.t);
    $("tlEmpty").hidden = ev.length > 0;
    renderTimeline(ev);
    if (lastAdded !== null)
      setTimeout(() => {
        lastAdded = null;
      }, 800);

    renderHistory();

    if (document.activeElement !== $("sWake")) {
      $("sWake").value = settings.wake;
      $("sMeals").value = settings.meals;
      $("sGapH").value = settings.gap / 60;
      $("sInterval").value = settings.interval;
      $("sLimit").value = settings.limit;
    }
  }
  function cancelConfirm(li) {
    clearTimeout(li._t);
    li.classList.remove("confirm");
    const b = li.querySelector("button");
    if (b) {
      b.innerHTML = '<svg class="ic sm"><use href="#i-trash"/></svg>';
      b.setAttribute("aria-label", "Видалити");
    }
  }
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#timeline li.confirm"))
      $("timeline").querySelectorAll("li.confirm").forEach(cancelConfirm);
  });
  let toastT;
  function toast(m) {
    const t = $("toast");
    t.textContent = m;
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), 2200);
  }

  // ---- tabs
  let curTab = "home",
    period = "day",
    openDay = null;
  try {
    curTab = localStorage.getItem("mst-tab") || "home";
  } catch {}
  function withTransition(fn) {
    if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches)
      document.startViewTransition(fn);
    else fn();
  }
  function showTab(t) {
    if (t === curTab && !$("tab-" + t).hidden) return;
    withTransition(() => showTabNow(t));
  }
  function showTabNow(t) {
    curTab = t;
    try {
      localStorage.setItem("mst-tab", t);
    } catch {}
    document.querySelectorAll(".tab").forEach((m) => (m.hidden = m.id !== "tab-" + t));
    document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    window.scrollTo(0, 0);
    if (t === "history") renderHistory();
  }
  document.querySelectorAll(".tabbar button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  $("seg")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          if (period === b.dataset.p) return;
          withTransition(() => {
            period = b.dataset.p;
            $("seg")
              .querySelectorAll("button")
              .forEach((x) => x.classList.toggle("on", x === b));
            renderHistory();
          });
        })
    );

  // ---- history
  const H = 3600000,
    MIN = 60000;
  const minsInDay = (ms, k) => Math.round((ms - keyDate(k).setHours(0, 0, 0, 0)) / MIN);
  function hmFromMin(m) {
    return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const sd = (a) => {
    if (a.length < 2) return null;
    const m = avg(a);
    return Math.sqrt(avg(a.map((x) => (x - m) * (x - m))));
  };
  const bucketOf = (ms) => {
    const h = new Date(ms).getHours();
    return h < 5 ? 3 : h < 12 ? 0 : h < 17 ? 1 : h < 23 ? 2 : 3;
  };
  const BUCKETS = ["Ранок", "День", "Вечір", "Ніч"];
  function slotIndexes(rec, n) {
    // every meal fills the next plan slot in order
    return (rec.meals || [])
      .slice()
      .sort((a, b) => a - b)
      .map((m, i) => [m, i < n ? i : -1]);
  }
  function dayStats(rec, k) {
    const meals = (rec.meals || []).slice().sort((a, b) => a - b),
      sticks = (rec.sticks || []).slice().sort((a, b) => a - b),
      types = rec.types || {};
    const mains = meals; // all meals count; snacks are only a label
    const gaps = sticks.map((t) => {
      const prev = [...meals].reverse().find((m) => m <= t);
      return prev ? (t - prev) / MIN : null;
    });
    const known = gaps.filter((g) => g !== null);
    const ok = gaps.filter((g) => g !== null && g >= settings.gap).length;
    const intervals = sticks.slice(1).map((t, i) => (t - sticks[i]) / MIN);
    const longest = Math.max(
      0,
      ...intervals,
      ...(rec.wake && sticks.length ? [(sticks[0] - rec.wake) / MIN] : [])
    );
    const dinner = [...meals].reverse().find((m) => types[m] === "Вечеря");
    const lateFrom = dinner || keyDate(k).setHours(21, 0, 0, 0);
    const late = sticks.filter((t) => t > lateFrom).length;
    const buckets = [0, 0, 0, 0];
    sticks.forEach((t) => buckets[bucketOf(t)]++);
    const mealGaps = meals.slice(1).map((t, i) => (t - meals[i]) / MIN);
    const pr = allDays[prevKey(k)];
    const sleepH = pr && pr.sleep && rec.wake ? (rec.wake - pr.sleep) / H : null;
    const n = settings.meals;
    const pl = planFor(rec, k);
    const dev = slotIndexes(rec, n)
      .filter(([m, i]) => i >= 0)
      .map(([m, i]) => Math.abs(minsInDay(m, k) - pl[i]));
    const isToday = k === dayKey();
    return {
      sticks: sticks.length,
      meals: mains.length,
      snacks: meals.filter((m) => types[m] === "Перекус").length,
      avgGap: avg(known),
      early: gaps.filter((g) => g !== null && g < settings.gap).length,
      fasting: gaps.filter((g) => g === null).length,
      ok,
      firstAfterWake: rec.wake && sticks.length ? (sticks[0] - rec.wake) / MIN : null,
      avgInterval: avg(intervals),
      longest: intervals.length || (rec.wake && sticks.length) ? longest : null,
      late,
      buckets,
      mealGapAvg: avg(mealGaps),
      mealGapMax: mealGaps.length ? Math.max(...mealGaps) : null,
      lastMealBeforeSleep: rec.sleep && meals.length ? (rec.sleep - meals[meals.length - 1]) / MIN : null,
      planDev: avg(dev),
      missed: isToday ? null : Math.max(0, n - mains.length),
      sleepH: sleepH !== null && sleepH > 0 && sleepH < 20 ? sleepH : null,
      wakeMin: rec.wake ? minsInDay(rec.wake, k) : null,
      sleepMin: rec.sleep ? minsInDay(rec.sleep, k) : null,
      withinLimit: settings.limit > 0 ? sticks.length <= settings.limit : true,
    };
  }
  function lastKeys(n, offset = 0) {
    const r = [];
    for (let i = n - 1 + offset; i >= offset; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      r.push(dayKey(d));
    }
    return r;
  }
  function tile(v, l, cls, delta) {
    return `<div class="tile ${cls || ""}"><div class="v">${v}</div><div class="l">${l}</div>${delta || ""}</div>`;
  }
  function fmtH(min) {
    if (min === null || min === undefined) return "–";
    const h = Math.floor(min / 60),
      m = Math.round(min % 60);
    return h ? `${h} год${m ? ` ${m} хв` : ""}` : `${m} хв`;
  }
  function delta(cur, prev, lowerIsBetter = true, unit = "") {
    // trend chip vs previous period
    if (cur === null || prev === null || prev === undefined) return "";
    const d = cur - prev;
    if (Math.abs(d) < 0.05)
      return `<div class="d flat"><svg class="ic"><use href="#i-flat"/></svg>без змін</div>`;
    const better = lowerIsBetter ? d < 0 : d > 0;
    const pct = prev ? Math.round((Math.abs(d) / Math.abs(prev)) * 100) : null;
    const num =
      Number.isInteger(cur) && Number.isInteger(prev)
        ? Math.abs(d).toFixed(0)
        : Math.abs(d).toFixed(unit === " хв" || unit === "%" ? 0 : 1);
    return `<div class="d ${better ? "down" : "up"}" title="порівняно з попереднім періодом"><svg class="ic"><use href="#i-${d < 0 ? "down" : "up"}"/></svg>${d > 0 ? "+" : "−"}${num}${unit}${pct !== null && unit !== "%" ? ` · ${pct}%` : ""}</div>`;
  }
  function streaks() {
    // days within limit, ending today/yesterday
    const keys = Object.keys(allDays).sort();
    let cur = 0,
      best = 0,
      run = 0,
      prev = null;
    for (const k of keys) {
      const st = dayStats(allDays[k], k);
      const consecutive = prev && keyDate(k) - keyDate(prev) === 86400000;
      run = st.withinLimit ? (consecutive ? run + 1 : 1) : 0;
      best = Math.max(best, run);
      prev = k;
    }
    const last = keys[keys.length - 1];
    const t = dayKey(),
      y = lastKeys(2)[0];
    cur = last === t || last === y ? run : 0;
    return { cur, best };
  }
  function periodAgg(keys) {
    const st = keys.filter((k) => allDays[k]).map((k) => dayStats(allDays[k], k));
    const n = keys.length,
      logged = st.length;
    const total = st.reduce((a, x) => a + x.sticks, 0);
    const okAll = st.reduce((a, x) => a + x.ok, 0),
      gapKnown = st.reduce((a, x) => a + x.ok + x.early, 0);
    const buckets = [0, 0, 0, 0];
    st.forEach((x) => x.buckets.forEach((v, i) => (buckets[i] += v)));
    const short = st.filter((x) => x.sleepH !== null && x.sleepH < 7),
      normal = st.filter((x) => x.sleepH !== null && x.sleepH >= 7);
    return {
      n,
      logged,
      total,
      avgPerDay: logged ? total / logged : null,
      within: st.filter((x) => x.withinLimit).length,
      maxDay: Math.max(0, ...st.map((x) => x.sticks)),
      avgGap: avg(st.filter((x) => x.avgGap !== null).map((x) => x.avgGap)),
      early: st.reduce((a, x) => a + x.early + x.fasting, 0),
      okPct: gapKnown ? Math.round((okAll / gapKnown) * 100) : null,
      firstAfterWake: avg(st.filter((x) => x.firstAfterWake !== null).map((x) => x.firstAfterWake)),
      avgInterval: avg(st.filter((x) => x.avgInterval !== null).map((x) => x.avgInterval)),
      longest: Math.max(0, ...st.map((x) => x.longest || 0)) || null,
      late: st.reduce((a, x) => a + x.late, 0),
      buckets,
      mealsAvg: logged ? st.reduce((a, x) => a + x.meals, 0) / logged : null,
      snacks: st.reduce((a, x) => a + x.snacks, 0),
      mealGapAvg: avg(st.filter((x) => x.mealGapAvg !== null).map((x) => x.mealGapAvg)),
      mealGapMax: Math.max(0, ...st.map((x) => x.mealGapMax || 0)) || null,
      lastMealBeforeSleep: avg(
        st.filter((x) => x.lastMealBeforeSleep !== null).map((x) => x.lastMealBeforeSleep)
      ),
      planDev: avg(st.filter((x) => x.planDev !== null).map((x) => x.planDev)),
      missed: st.reduce((a, x) => a + (x.missed || 0), 0),
      sleepAvg: avg(st.filter((x) => x.sleepH !== null).map((x) => x.sleepH)),
      wakeAvg: avg(st.filter((x) => x.wakeMin !== null).map((x) => x.wakeMin)),
      sleepMinAvg: avg(st.filter((x) => x.sleepMin !== null).map((x) => x.sleepMin)),
      wakeSd: sd(st.filter((x) => x.wakeMin !== null).map((x) => x.wakeMin)),
      sleepSd: sd(st.filter((x) => x.sleepMin !== null).map((x) => x.sleepMin)),
      sticksShortSleep: avg(short.map((x) => x.sticks)),
      sticksNormalSleep: avg(normal.map((x) => x.sticks)),
      shortN: short.length,
      normalN: normal.length,
      bestDay: st.length
        ? keys.filter((k) => allDays[k])[st.indexOf(st.reduce((a, b) => (b.sticks < a.sticks ? b : a)))]
        : null,
    };
  }
  let histSig = "";
  function renderHistory(force) {
    if ($("tab-history").hidden) return;
    const sig = JSON.stringify([
      period,
      openDay,
      settings,
      dayKey(),
      Object.keys(allDays).map((k) => k + ":" + (allDays[k].updatedAt || 0)),
      today.meals.length,
      today.sticks.length,
    ]);
    if (!force && sig === histSig) return;
    histSig = sig;
    const keysAll = Object.keys(allDays).sort().reverse();
    $("histEmpty").hidden = keysAll.length > 0;
    const isDay = period === "day",
      span = period === "month" ? 30 : 7;
    const chartKeys = isDay ? lastKeys(7) : lastKeys(span);
    const keys = isDay ? keysAll.slice(0, 60) : chartKeys.slice().reverse();
    const cur = periodAgg(isDay ? [dayKey()] : chartKeys),
      prev = isDay ? periodAgg(lastKeys(1, 1)) : periodAgg(lastKeys(span, span));
    const stk = streaks();
    $("trendNote").textContent = prev.logged
      ? `Стрілки - порівняно з ${isDay ? "учорашнім днем" : period === "month" ? "попередніми 30 днями" : "попереднім тижнем"}.`
      : "";
    const dl = (c, p, low, unit) => (prev.logged ? delta(c, p, low, unit) : "");
    const lim = settings.limit,
      g = settings.gap;
    // ---- sticks
    let t = "";
    if (isDay) {
      t += tile(
        cur.total,
        "стіків сьогодні",
        lim && cur.total > lim ? "bad" : "stick",
        dl(cur.total, prev.total, true, "")
      );
      t += tile(
        cur.firstAfterWake !== null ? fmtH(cur.firstAfterWake) : "–",
        "перший стік після підйому",
        cur.firstAfterWake !== null && cur.firstAfterWake >= 120 ? "good" : "",
        dl(cur.firstAfterWake, prev.firstAfterWake, false, " хв")
      );
      t += tile(
        cur.avgInterval !== null ? fmtH(cur.avgInterval) : "–",
        "між стіками в середньому",
        "",
        dl(cur.avgInterval, prev.avgInterval, false, " хв")
      );
      t += tile(
        cur.longest !== null ? fmtH(cur.longest) : "–",
        "найдовше без стіка",
        cur.longest >= 240 ? "good" : ""
      );
      t += tile(cur.late, "після вечері", cur.late ? "bad" : "good", dl(cur.late, prev.late, true, ""));
      t += tile(
        stk.cur,
        `днів поспіль у межах цілі<small> · рекорд ${stk.best}</small>`,
        stk.cur ? "good" : ""
      );
    } else {
      t += tile(cur.total, "стіків усього", "stick", dl(cur.total, prev.total, true, ""));
      t += tile(
        cur.avgPerDay !== null ? cur.avgPerDay.toFixed(1) : "–",
        "в середньому за день",
        lim && cur.avgPerDay > lim ? "bad" : "stick",
        dl(cur.avgPerDay, prev.avgPerDay, true, "")
      );
      t += tile(
        `${cur.within}/${cur.logged}`,
        "днів у межах цілі",
        cur.logged && cur.within === cur.logged ? "good" : ""
      );
      t += tile(cur.maxDay, "максимум за день", lim && cur.maxDay > lim ? "bad" : "");
      t += tile(
        cur.firstAfterWake !== null ? fmtH(cur.firstAfterWake) : "–",
        "перший стік після підйому",
        cur.firstAfterWake >= 120 ? "good" : "",
        dl(cur.firstAfterWake, prev.firstAfterWake, false, " хв")
      );
      t += tile(
        cur.avgInterval !== null ? fmtH(cur.avgInterval) : "–",
        "між стіками в середньому",
        "",
        dl(cur.avgInterval, prev.avgInterval, false, " хв")
      );
      t += tile(
        cur.longest !== null ? fmtH(cur.longest) : "–",
        "найдовша пауза без стіка",
        cur.longest >= 240 ? "good" : ""
      );
      t += tile(
        cur.late,
        "після вечері за період",
        cur.late ? "bad" : "good",
        dl(cur.late, prev.late, true, "")
      );
      t += tile(
        stk.cur,
        `днів поспіль у межах цілі<small> · рекорд ${stk.best}</small>`,
        stk.cur ? "good" : ""
      );
    }
    $("tilesSticks").innerHTML = t;
    // ---- hours
    const bt = cur.buckets.reduce((a, b) => a + b, 0),
      bmax = Math.max(1, ...cur.buckets);
    $("hours").innerHTML = BUCKETS.map((b, i) => {
      const v = cur.buckets[i];
      const pct = bt ? Math.round((v / bt) * 100) : 0;
      return `<div><span class="lb">${b}<small>${["5–12", "12–17", "17–23", "23–5"][i]}</small></span><div class="bar"><i class="${i === 3 ? "night" : ""}" data-w="${Math.round((v / bmax) * 100)}" style="width:0"></i></div><span class="n">${v}${bt ? ` · ${pct}%` : ""}</span></div>`;
    }).join("");
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        $("hours")
          .querySelectorAll("i")
          .forEach((i) => (i.style.width = i.dataset.w + "%"))
      )
    );
    // ---- food
    t = "";
    t += tile(
      cur.okPct !== null ? cur.okPct + "%" : "–",
      "стіків після повної паузи",
      cur.okPct === 100 ? "good" : cur.okPct !== null && cur.okPct < 70 ? "bad" : "",
      dl(cur.okPct, prev.okPct, false, "%")
    );
    t += tile(
      cur.avgGap !== null ? fmtH(cur.avgGap) : "–",
      "середня пауза після їжі",
      cur.avgGap !== null && cur.avgGap < g ? "bad" : "good",
      dl(cur.avgGap, prev.avgGap, false, " хв")
    );
    t += tile(
      cur.early,
      "зарано / натщесерце",
      cur.early ? "bad" : "good",
      dl(cur.early, prev.early, true, "")
    );
    t += tile(
      isDay
        ? cur.mealsAvg !== null
          ? cur.mealsAvg
          : "–"
        : cur.mealsAvg !== null
          ? cur.mealsAvg.toFixed(1)
          : "–",
      isDay ? "прийомів їжі" : "прийомів їжі на день",
      "meal"
    );
    t += tile(cur.snacks, isDay ? "перекусів" : "перекусів за період", "");
    t += tile(
      cur.mealGapAvg !== null ? fmtH(cur.mealGapAvg) : "–",
      "між прийомами їжі",
      "",
      dl(cur.mealGapAvg, prev.mealGapAvg, true, " хв")
    );
    t += tile(
      cur.mealGapMax !== null ? fmtH(cur.mealGapMax) : "–",
      "найдовше голодне вікно",
      cur.mealGapMax > 300 ? "bad" : ""
    );
    t += tile(
      cur.lastMealBeforeSleep !== null ? fmtH(cur.lastMealBeforeSleep) : "–",
      "від останньої їжі до сну",
      cur.lastMealBeforeSleep !== null ? (cur.lastMealBeforeSleep < 120 ? "bad" : "good") : ""
    );
    t += tile(
      cur.planDev !== null ? Math.round(cur.planDev) + " хв" : "–",
      "відхилення від плану",
      cur.planDev !== null && cur.planDev > 60 ? "bad" : ""
    );
    if (!isDay) t += tile(cur.missed, "пропущених прийомів", cur.missed ? "bad" : "good");
    $("tilesFood").innerHTML = t;
    // ---- sleep
    t = "";
    t += tile(
      cur.sleepAvg !== null ? cur.sleepAvg.toFixed(1) + " год" : "–",
      isDay ? "сон" : "сон у середньому",
      cur.sleepAvg !== null ? (cur.sleepAvg < 7 ? "bad" : "good") : "",
      dl(cur.sleepAvg, prev.sleepAvg, false, " год")
    );
    t += tile(
      cur.wakeAvg !== null ? hmFromMin(Math.round(cur.wakeAvg)) : "–",
      isDay ? "підйом" : "середній підйом",
      ""
    );
    t += tile(
      cur.sleepMinAvg !== null ? hmFromMin(Math.round(cur.sleepMinAvg)) : "–",
      isDay ? "відбій" : "середній відбій",
      ""
    );
    if (!isDay) {
      t += tile(
        cur.wakeSd !== null ? "±" + Math.round(cur.wakeSd) + " хв" : "–",
        "розкид підйому",
        cur.wakeSd !== null ? (cur.wakeSd > 60 ? "bad" : "good") : ""
      );
      t += tile(
        cur.sleepSd !== null ? "±" + Math.round(cur.sleepSd) + " хв" : "–",
        "розкид відбою",
        cur.sleepSd !== null ? (cur.sleepSd > 60 ? "bad" : "good") : ""
      );
      t += tile(
        cur.shortN && cur.normalN
          ? `${cur.sticksShortSleep.toFixed(1)}<small>vs ${cur.sticksNormalSleep.toFixed(1)}</small>`
          : "–",
        `стіків після сну &lt;7 год vs ≥7<small>· ${cur.shortN}/${cur.normalN} дн</small>`,
        cur.shortN && cur.normalN && cur.sticksShortSleep > cur.sticksNormalSleep ? "bad" : ""
      );
    }
    $("tilesSleep").innerHTML = t;
    // ---- report
    const rep = $("report");
    if (!isDay && cur.logged) {
      const pn = period === "month" ? "цього місяця" : "цього тижня",
        pp = period === "month" ? "минулого місяця" : "минулого тижня";
      const lines = [];
      lines.push(
        `<p><b>${cur.total}</b> стіків ${pn}${prev.logged ? `, ${cur.total < prev.total ? "на <b>" + Math.round(((prev.total - cur.total) / Math.max(prev.total, 1)) * 100) + "% менше</b>" : cur.total > prev.total ? "на <b>" + Math.round(((cur.total - prev.total) / Math.max(prev.total, 1)) * 100) + "% більше</b>" : "стільки ж"} ніж ${pp}` : ""}. У середньому <b>${cur.avgPerDay.toFixed(1)}</b> на день при цілі ${lim || "без ліміту"}.</p>`
      );
      if (cur.bestDay)
        lines.push(
          `<p>Найкращий день - <b>${keyDate(cur.bestDay).toLocaleDateString("uk-UA", { weekday: "long", day: "numeric", month: "long" })}</b> (${dayStats(allDays[cur.bestDay], cur.bestDay).sticks} стіків). У межах цілі <b>${cur.within} з ${cur.logged}</b> днів${stk.cur ? `, зараз серія <b>${stk.cur}</b>` : ""}.</p>`
        );
      if (cur.okPct !== null)
        lines.push(
          `<p>Після повної паузи - <b>${cur.okPct}%</b> стіків${cur.early ? `, зарано або натщесерце - <b>${cur.early}</b>` : ""}${cur.late ? `, після вечері - <b>${cur.late}</b>` : ""}.</p>`
        );
      if (cur.firstAfterWake !== null)
        lines.push(
          `<p>Перший стік у середньому через <b>${fmtH(cur.firstAfterWake)}</b> після підйому${cur.sleepAvg !== null ? `, сон <b>${cur.sleepAvg.toFixed(1)} год</b>` : ""}.</p>`
        );
      const bi = cur.buckets.indexOf(Math.max(...cur.buckets));
      if (bt)
        lines.push(
          `<p>Найбільше курю ${["зранку", "вдень", "ввечері", "вночі"][bi]} - <b>${Math.round((cur.buckets[bi] / bt) * 100)}%</b>.</p>`
        );
      $("reportTitle").textContent = period === "month" ? "Підсумок місяця" : "Підсумок тижня";
      $("reportBody").innerHTML = lines.join("");
      rep.hidden = false;
    } else rep.hidden = true;
    // ---- chart
    $("histChartTitle").textContent = isDay || span === 7 ? "Останні 7 днів" : "Останні 30 днів";
    const w = $("histChart");
    w.className = "week" + (span === 30 && !isDay ? " m" : "");
    const cnt = (k) => (allDays[k] ? (allDays[k].sticks || []).length : 0);
    const max = Math.max(lim, ...chartKeys.map(cnt), 1);
    w.innerHTML = chartKeys
      .map((k) => {
        const c = cnt(k);
        const h = Math.round((c / max) * 44);
        const over = lim > 0 && c > lim;
        const d = keyDate(k);
        const month = !isDay && span === 30;
        const lab = month
          ? d.getDate() % 5 === 1 || chartKeys.length < 10
            ? String(d.getDate())
            : ""
          : d.toLocaleDateString("uk-UA", { weekday: "short" });
        return `<div class="d"><div class="bar"><i class="${over ? "over" : ""}" data-h="${h}" style="height:2px"></i></div><div class="n">${month ? c || "" : c}</div><div>${lab}</div></div>`;
      })
      .join("");
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        w.querySelectorAll("i").forEach((i) => (i.style.height = i.dataset.h + "px"))
      )
    );
    // ---- heatmap: 12 columns = weeks (Mon..Sun), last column is the current week
    const todayK = dayKey();
    const td = keyDate(todayK);
    const dow = (td.getDay() + 6) % 7; // 0=Mon
    const start = new Date(td);
    start.setDate(td.getDate() - dow - 7 * 11);
    let cols = "";
    for (let c = 0; c < 12; c++) {
      let col = "";
      for (let r = 0; r < 7; r++) {
        const d = new Date(start);
        d.setDate(start.getDate() + c * 7 + r);
        const k = dayKey(new Date(d.getTime() + DAY_SHIFT * MIN + MIN));
        const future = d > td;
        const rec = allDays[k];
        const n = rec ? (rec.sticks || []).length : 0;
        let lv = "";
        if (rec) {
          lv =
            n === 0
              ? "l0"
              : lim
                ? n > lim
                  ? n > lim * 1.5
                    ? "l5"
                    : "l4"
                  : n <= lim / 3
                    ? "l1"
                    : n <= (lim * 2) / 3
                      ? "l2"
                      : "l3"
                : "l3";
        }
        col += `<i class="${lv}${k === todayK ? " today" : ""}${future ? " future" : ""}" title="${d.toLocaleDateString("uk-UA", { day: "numeric", month: "short" })}: ${rec ? n : "–"}"></i>`;
      }
      cols += `<div class="col">${col}</div>`;
    }
    $("heat").innerHTML =
      `<div class="lbl">${["пн", "", "ср", "", "пт", "", "нд"].map((x) => `<span>${x}</span>`).join("")}</div>` +
      cols;
    // ---- list
    $("histListTitle").textContent = isDay ? "Усі дні" : "Дні періоду";
    $("histList").innerHTML = keys
      .filter((k) => allDays[k])
      .map((k) => {
        const r = allDays[k],
          x = dayStats(r, k),
          d = keyDate(k),
          over = lim > 0 && x.sticks > lim,
          isOpen = openDay === k;
        const rm = r.meals || [],
          rs = r.sticks || [];
        const ev = [
          ...rm.map((t) => ({ k: "meal", t })),
          ...rs.map((t) => ({ k: "stick", t })),
          ...(r.wake ? [{ k: "wake", t: r.wake }] : []),
          ...(r.sleep ? [{ k: "sleep", t: r.sleep }] : []),
        ].sort((a, b) => a.t - b.t);
        const sub = isOpen
          ? `<div class="sub">${
              ev
                .map((e) => {
                  let note = "";
                  if (e.k === "stick") {
                    const prev = [...rm].reverse().find((m) => m <= e.t);
                    note = prev ? `через ${fmtDur(e.t - prev)}` : "натщесерце";
                  }
                  return `<div class="${e.k}"><span class="t">${hm(e.t)}</span><span>${e.k === "meal" ? (r.types || {})[e.t] || "Їжа" : e.k === "stick" ? "Стік" : e.k === "wake" ? "Підйом" : "Сон"} <span class="note">${note}</span></span></div>`;
                })
                .join("") || "<span class=note>порожньо</span>"
            }</div>`
          : "";
        const meta = [
          x.wakeMin !== null ? "підйом " + hmFromMin(x.wakeMin) : "",
          x.sleepH !== null ? "сон " + x.sleepH.toFixed(1) + " год" : "",
          x.firstAfterWake !== null ? "перший стік +" + fmtH(x.firstAfterWake) : "",
          x.late ? "після вечері " + x.late : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return `<li><div class="row" data-k="${k}"><span class="dt">${d.toLocaleDateString("uk-UA", { day: "numeric", month: "short" })}<small>${d.toLocaleDateString("uk-UA", { weekday: "short" })}</small></span><span class="pill meal">їжа ${x.meals}</span><span class="pill stick ${over ? "over" : ""}">стіки ${x.sticks}</span></div>${meta ? `<div class="note" style="margin-top:4px">${meta}</div>` : ""}${sub}</li>`;
      })
      .join("");
    $("histList")
      .querySelectorAll(".row")
      .forEach(
        (r) =>
          (r.onclick = () => {
            withTransition(() => {
              openDay = openDay === r.dataset.k ? null : r.dataset.k;
              renderHistory();
            });
          })
      );
  }

  // ---- cloud sync (Firestore, keyed by a private sync key; local storage stays the source of truth offline)
  const FB_CONFIG = {
    apiKey: "AIzaSyCGtI9ENgpq4sHdKyTn6NUGWfA3_SSCXrU",
    authDomain: "meal-stick-tracker.firebaseapp.com",
    projectId: "meal-stick-tracker",
    storageBucket: "meal-stick-tracker.firebasestorage.app",
    messagingSenderId: "19994207262",
    appId: "1:19994207262:web:dc54e05c073398856a7a0f",
  };
  const VAPID = "BMc5jgorZwN2ttw8XeSFqKWcthMiQui6URuxocy4xebrsU5qm7jgXOnUp-7RZgCdxFR-DbHIg1cU1pHgVYgpTYQ";
  const KEY_LS = "mst-sync-key";
  function newKey() {
    const a = new Uint8Array(24);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  }
  const cloud = (() => {
    let fs = null,
      key = null,
      unsubDays = null,
      unsubSet = null,
      ready = false,
      swReg = null,
      pushToken = null;
    try {
      key = localStorage.getItem(KEY_LS);
    } catch {}
    if (!key || key.length < 24) {
      key = newKey();
      try {
        localStorage.setItem(KEY_LS, key);
      } catch {}
    }
    function state(txt, cls) {
      const el = $("cloudState");
      if (el) el.innerHTML = `<span class="cloudDot ${cls || ""}"></span>${txt}`;
    }
    function space() {
      return fs.collection("spaces").doc(key);
    }
    function init() {
      $("syncKey").value = key;
      if (!window.firebase || !firebase.firestore) {
        state("Firebase не завантажився - працюю локально", "off");
        return;
      }
      try {
        firebase.initializeApp(FB_CONFIG);
        fs = firebase.firestore();
        fs.settings({ experimentalAutoDetectLongPolling: true, ignoreUndefinedProperties: true });
      } catch {
        state("Помилка ініціалізації", "off");
        return;
      }
      fs.enablePersistence({ synchronizeTabs: true }).catch(() => {}); // offline queue for writes
      ready = true;
      $("syncKey").value = key;
      subscribe();
    }
    function subscribe() {
      if (unsubDays) unsubDays();
      if (unsubSet) unsubSet();
      state("Синхронізація…");
      unsubDays = space()
        .collection("days")
        .onSnapshot(
          { includeMetadataChanges: true }, // fires again when the cache view becomes a server view
          (snap) => {
            let changed = false;
            snap.docChanges().forEach((ch) => {
              const k = ch.doc.id,
                c = ch.doc.data();
              const l = allDays[k];
              if (ch.type === "removed") return;
              if (!l || (c.updatedAt || 0) > (l.updatedAt || 0)) {
                allDays[k] = c;
                changed = true;
              }
            });
            if (changed) {
              const ls = lsLoad();
              ls.days = allDays;
              lsSave(ls);
              if (idb)
                for (const k in allDays) tx("days", "readwrite", (s) => s.put(allDays[k], k)).catch(() => {});
              setToday(dayKey());
              render();
            }
            // first snapshot: upload local days the cloud doesn't have (migration)
            if (!subscribe.migrated) {
              subscribe.migrated = true;
              const cloudKeys = new Set(snap.docs.map((d) => d.id));
              Object.keys(allDays).forEach((k) => {
                if (!cloudKeys.has(k))
                  space()
                    .collection("days")
                    .doc(k)
                    .set(allDays[k])
                    .catch(() => {});
              });
              pushSettings();
              pushPlan();
            }
            state(
              snap.metadata.fromCache
                ? "Офлайн - зміни синхронізуються пізніше"
                : "Синхронізовано · " +
                    new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }),
              snap.metadata.fromCache ? "" : "on"
            );
          },
          (err) => {
            state("Немає доступу до хмари: " + (err.code || err.message), "off");
          }
        );
      unsubSet = space()
        .collection("meta")
        .doc("settings")
        .onSnapshot(
          (d) => {
            if (!d.exists) return;
            const c = d.data();
            if ((c.updatedAt || 0) > (settings.updatedAt || 0)) {
              settings = { ...DEF, ...c };
              const ls = lsLoad();
              ls.settings = settings;
              lsSave(ls);
              render();
            }
          },
          () => {}
        );
    }
    function pushDay(k, rec) {
      if (!ready) return;
      space()
        .collection("days")
        .doc(k)
        .set(rec)
        .catch(() => {});
    }
    function pushSettings() {
      if (!ready) return;
      space()
        .collection("meta")
        .doc("settings")
        .set(settings)
        .catch(() => {});
    }
    function pushPlan() {
      // what the server should remind about
      if (!ready) return;
      const items = [];
      const nMeal = $("nMeal").checked,
        nStick = $("nStick").checked,
        now = Date.now();
      if (nMeal) {
        const pl = plan();
        const done = today.meals.length;
        const LOG_AFTER = 30 * 60000; // follow-up: "did you log it?" half an hour after the slot
        pl.forEach((m, i) => {
          if (i < done) return; // this slot is already filled by a logged meal
          const at = todayAt(m);
          const label = i === 0 ? "Сніданок" : i === pl.length - 1 ? "Вечеря" : i === 1 ? "Обід" : "Перекус";
          if (at >= now - 60000)
            items.push({
              id: "meal-" + dayKey() + "-" + i,
              kind: "meal",
              at,
              title: "Час їсти - " + label.toLowerCase(),
              body: `За планом о ${hm(at)}. Після їжі відміть «Я поїв».`,
            });
          // Disappears automatically: logging the meal re-runs pushPlan and this slot becomes "done".
          if (at + LOG_AFTER >= now - 60000)
            items.push({
              id: "log-" + dayKey() + "-" + i,
              kind: "log",
              at: at + LOG_AFTER,
              title: "Записав їжу?",
              body: `${label} був за планом о ${hm(at)}, а запису ще немає. Якщо поїв - відміть «Я поїв».`,
            });
        });
      }
      if (nStick) {
        const s = statusNow();
        if (s.ring)
          items.push({
            id: "stick-" + s.ring.to,
            kind: "stick",
            at: s.ring.to,
            title: "Можна стік",
            body: `Минуло ${fmtDur(settings.gap * 60000)} після їжі о ${hm(s.ring.from)}.`,
          });
      }
      const nextAt = items.length ? Math.min(...items.map((i) => i.at)) : null;
      const doc = { items, nextAt, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, updatedAt: now };
      if (pushToken) doc.tokens = firebase.firestore.FieldValue.arrayUnion(pushToken);
      fs.collection("plans")
        .doc(key)
        .set(doc, { merge: true })
        .catch(() => {});
      // forget notified marks for ids that are gone (keeps the doc small)
    }
    async function enablePush() {
      const st = $("notifState");
      if (!("Notification" in window)) {
        st.textContent =
          "Сповіщення недоступні у цьому режимі. На iPhone додай застосунок на екран Домівка і відкрий звідти.";
        return;
      }
      if (!ready) {
        st.textContent = "Хмара ще не підключена.";
        return;
      }
      try {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") {
          st.textContent = "Дозвіл не надано. Увімкни в Налаштуваннях iOS → Сповіщення.";
          return;
        }
        swReg = swReg || (await navigator.serviceWorker.ready);
        const m = firebase.messaging();
        pushToken = await m.getToken({ vapidKey: VAPID, serviceWorkerRegistration: swReg });
        try {
          localStorage.setItem("mst-push", pushToken);
        } catch {}
        await fs
          .collection("plans")
          .doc(key)
          .set({ tokens: firebase.firestore.FieldValue.arrayUnion(pushToken) }, { merge: true });
        st.textContent = "Сповіщення увімкнені на цьому пристрої.";
        $("btnNotif").innerHTML = '<svg class="ic sm"><use href="#i-bell"/></svg>Сповіщення увімкнені';
        $("btnNotifTest").hidden = false;
        pushPlan();
      } catch (e) {
        st.textContent = "Не вдалося: " + (e.code || e.message);
      }
    }
    async function testPush() {
      if (!ready || !pushToken) return;
      const at = Date.now() + 60000;
      await fs
        .collection("plans")
        .doc(key)
        .set(
          {
            items: [
              {
                id: "test-" + at,
                kind: "test",
                at,
                title: "Тест сповіщення",
                body: "Якщо ти це бачиш - усе працює.",
              },
            ],
            nextAt: at,
            updatedAt: Date.now(),
          },
          { merge: true }
        );
      toast("Прийде приблизно за хвилину. Можна закрити додаток.");
    }
    async function refreshToken() {
      // tokens rotate; refresh silently when already allowed
      if (!ready || !("Notification" in window) || Notification.permission !== "granted") return;
      try {
        swReg = swReg || (await navigator.serviceWorker.ready);
        pushToken = await firebase
          .messaging()
          .getToken({ vapidKey: VAPID, serviceWorkerRegistration: swReg });
        $("notifState").textContent = "Сповіщення увімкнені на цьому пристрої.";
        $("btnNotif").innerHTML = '<svg class="ic sm"><use href="#i-bell"/></svg>Сповіщення увімкнені';
        $("btnNotifTest").hidden = false;
        pushPlan();
      } catch {}
    }
    function applyKey() {
      const v = $("syncKey").value.trim().toLowerCase();
      if (!/^[a-z0-9]{24,64}$/.test(v)) {
        toast("Ключ: 24-64 символи, латиниця і цифри");
        return;
      }
      if (v === key) return;
      key = v;
      try {
        localStorage.setItem(KEY_LS, key);
      } catch {}
      subscribe.migrated = false;
      subscribe();
      toast("Ключ застосовано");
    }
    return {
      init,
      pushDay,
      pushSettings,
      pushPlan,
      enablePush,
      testPush,
      refreshToken,
      applyKey,
      getKey: () => key,
    };
  })();
  $("keyApply").onclick = cloud.applyKey;
  $("keyCopy").onclick = () => {
    const v = $("syncKey").value;
    navigator.clipboard &&
      navigator.clipboard
        .writeText(v)
        .then(() => toast("Скопійовано"))
        .catch(() => {
          $("syncKey").select();
        });
  };
  $("btnNotif").onclick = cloud.enablePush;
  $("btnNotifTest").onclick = cloud.testPush;
  $("nMeal").onchange = $("nStick").onchange = () => {
    try {
      localStorage.setItem(
        "mst-notif",
        JSON.stringify({ meal: $("nMeal").checked, stick: $("nStick").checked })
      );
    } catch {}
    cloud.pushPlan();
  };
  try {
    const n = JSON.parse(localStorage.getItem("mst-notif") || "null");
    if (n) {
      $("nMeal").checked = !!n.meal;
      $("nStick").checked = !!n.stick;
    }
  } catch {}

  // ---- pull to refresh (standalone PWA has no native one)
  (function () {
    const el = $("ptr"),
      txt = $("ptrText");
    let y0 = null,
      pulled = 0;
    const TH = 80;
    document.addEventListener(
      "touchstart",
      (e) => {
        if (window.scrollY <= 0 && e.touches.length === 1) {
          y0 = e.touches[0].clientY;
          pulled = 0;
        }
      },
      { passive: true }
    );
    document.addEventListener(
      "touchmove",
      (e) => {
        if (y0 === null) return;
        pulled = e.touches[0].clientY - y0;
        if (pulled < 10 || window.scrollY > 0) {
          el.className = "ptr";
          return;
        }
        const p = Math.min(pulled, TH * 1.5);
        el.querySelector("span").style.transform = `translateY(${p * 0.6 + 40}px)`;
        el.className = "ptr show" + (pulled > TH ? " ready" : "");
        txt.textContent = pulled > TH ? "Відпусти - оновлюю" : "Потягни, щоб оновити";
      },
      { passive: true }
    );
    function reset() {
      y0 = null;
      pulled = 0;
      el.className = "ptr";
      el.querySelector("span").style.transform = "";
    }
    document.addEventListener(
      "touchend",
      async () => {
        if (y0 !== null && pulled > TH && window.scrollY <= 0) {
          txt.textContent = "Оновлюю…";
          reset();
          await refreshAll();
          return;
        }
        reset();
      },
      { passive: true }
    );
    document.addEventListener("touchcancel", reset, { passive: true });
    window.addEventListener(
      "scroll",
      () => {
        if (window.scrollY > 0) reset();
      },
      { passive: true }
    );
  })();
  async function refreshAll() {
    try {
      if (navigator.serviceWorker) {
        const r = await navigator.serviceWorker.getRegistration();
        if (r) await Promise.race([r.update(), new Promise((res) => setTimeout(res, 3000))]);
      }
    } catch {}
    try {
      await loadAll();
    } catch {}
    histSig = "";
    render();
    toast("Оновлено");
  }

  // ---- online/offline indicator (data is local either way)
  function netState() {
    $("offline").hidden = navigator.onLine !== false;
  }
  window.addEventListener("online", () => {
    netState();
    toast("Інтернет є - перевіряю оновлення");
    if (navigator.serviceWorker)
      navigator.serviceWorker
        .getRegistration()
        .then((r) => r && r.update())
        .catch(() => {});
  });
  window.addEventListener("offline", () => {
    netState();
    toast("Офлайн - записи зберігаються на телефоні");
  });
  netState();

  // ---- boot (everything above is declared by now - showTab may render history)
  showTab(curTab);
  render();
  setInterval(render, 15000);
  loadAll().then(() => {
    cloud.init();
    setTimeout(cloud.refreshToken, 1500);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) ringTick();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) render();
  });
  $("btnExport").onclick = exportJson;
  $("importFile").onchange = (e) => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = "";
  };
  if ("serviceWorker" in navigator) {
    let reloading = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading || !hadController) return;
      reloading = true;
      location.reload();
    });
    window.addEventListener("load", async () => {
      try {
        const r = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
        const check = () => r.update().catch(() => {});
        check();
        setInterval(check, 15 * 60000);
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden) check();
        });
        r.addEventListener("updatefound", () => {
          const w = r.installing;
          if (!w) return;
          w.addEventListener("statechange", () => {
            if (w.state === "installed" && navigator.serviceWorker.controller) {
              w.postMessage("skipWaiting");
            }
          });
        });
      } catch {}
    });
  }
  $("btnUpdate").onclick = () => refreshAll();
})();
