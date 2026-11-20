/* Chat's Bookshelf – app logic
   Local-first: every change shows instantly, is saved on the device, and is
   synced to the server in the background (with retry + offline queue). */
(function () {
  "use strict";

  // ------------------------------------------------------------------ helpers
  var $ = function (id) { return document.getElementById(id); };
  var LS = {
    books: "chat.bookshelf.books.v1",
    prefs: "chat.bookshelf.prefs",
    queue: "chat.bookshelf.queue",
    synced: "chat.bookshelf.synced",
    hint: "chat.bookshelf.hint"
  };
  var PALETTE = ["#E3A6A0", "#8FA888", "#EFC75E", "#9DBEDD", "#C6A6D6", "#D9935C", "#7BA3A8", "#C4A484"];
  var STATUS_LABEL = { want: "Want to read", reading: "Reading", read: "Read" };

  function lsGet(key, fallback) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (e) {} }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function hashStr(s) {
    var str = String(s || ""), h = 0;
    for (var i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
    return h;
  }
  function pickPastel(seed) { return PALETTE[Math.abs(hashStr(seed || "default")) % PALETTE.length]; }

  function parseColor(c) {
    if (!c) return null;
    var m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(c);
    if (m) return [+m[1], +m[2], +m[3]];
    m = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(c);
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function luminance(rgb) {
    var a = rgb.map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function isLightColor(c) {
    var rgb = parseColor(c);
    return rgb ? luminance(rgb) > 0.3 : false;
  }
  function fgFor(c) { return isLightColor(c) ? "#3A2C2E" : "#ffffff"; }

  function coverUrl(id, size) {
    return "https://covers.openlibrary.org/b/id/" + encodeURIComponent(id) + "-" + size + ".jpg?default=false";
  }

  // ------------------------------------------------------------------ state
  var books = lsGet(LS.books, []);
  if (!Array.isArray(books)) books = [];
  var queue = lsGet(LS.queue, {});          // id -> { t:'put'|'del', at:ms }
  var syncedIds = lsGet(LS.synced, {});     // ids the server is known to have
  var prefs = lsGet(LS.prefs, {});
  var currentFilter = prefs.filter || "all";
  var currentSort = prefs.sort || "added";
  var openBookId = null;
  var apiMode = true;                       // false on a pure static deploy (no /api)
  var appOpen = false;
  var bookMap = {};
  var spineEls = {};
  var justAdded = null;

  function reindex() {
    bookMap = {};
    for (var i = 0; i < books.length; i++) bookMap[books[i].id] = books[i];
  }
  reindex();

  function persistBooks() { lsSet(LS.books, books); }
  function persistQueue() { lsSet(LS.queue, queue); }
  function savePrefs() { lsSet(LS.prefs, { filter: currentFilter, sort: currentSort }); }

  // Record a change to a book: stamp it, save locally, queue for sync, redraw.
  function commit(book, opts) {
    book.updatedAt = Date.now();
    bookMap[book.id] = book;
    persistBooks();
    queue[book.id] = { t: "put", at: book.updatedAt };
    persistQueue();
    scheduleSync(500);
    if (!opts || opts.render !== false) renderShelf();
  }

  // ------------------------------------------------------------------ toasts
  var toastsEl = $("toasts");
  function toast(msg, actionLabel, onAction, ms) {
    var el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = "<span>" + esc(msg) + "</span>";
    var timer;
    function dismiss() {
      clearTimeout(timer);
      el.classList.add("out");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
    }
    if (actionLabel) {
      var b = document.createElement("button");
      b.type = "button"; b.textContent = actionLabel;
      b.addEventListener("click", function () { dismiss(); onAction && onAction(); });
      el.appendChild(b);
    }
    toastsEl.appendChild(el);
    while (toastsEl.children.length > 3) toastsEl.removeChild(toastsEl.firstChild);
    timer = setTimeout(dismiss, ms || 4200);
  }

  // ------------------------------------------------------------------ network
  function api(method, path, body) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 12000);
    var opts = { method: method, signal: ctrl.signal, credentials: "same-origin", headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) {
      clearTimeout(timer);
      var ct = r.headers.get("content-type") || "";
      var isJson = ct.indexOf("json") !== -1;
      return (isJson ? r.json().catch(function () { return null; }) : Promise.resolve(null)).then(function (data) {
        return { status: r.status, ok: r.ok, data: data, isJson: isJson };
      });
    }, function (err) { clearTimeout(timer); throw err; });
  }

  // ------------------------------------------------------------------ sync
  var syncRunning = false, syncAgain = false, syncTimer = null, retryTimer = null;
  var failCount = 0, lastSync = 0;
  var syncPill = $("syncPill"), syncText = $("syncText");

  function setSync(state) {
    var labels = { saved: "Saved", syncing: "Syncing…", offline: "Offline · will sync", error: "Retrying…", local: "" };
    syncPill.setAttribute("data-state", state);
    syncText.textContent = labels[state] || "";
  }
  function pendingCount() { return Object.keys(queue).length; }

  function scheduleSync(delay) {
    if (!apiMode) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, delay || 0);
    if (pendingCount() && !syncRunning) setSync(navigator.onLine ? "syncing" : "offline");
  }

  function AuthError() { this.auth = true; }

  function flush() {
    var ids = Object.keys(queue);
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        var op = queue[id];
        if (!op) return;
        var req;
        if (op.t === "put") {
          var b = bookMap[id];
          if (!b) { delete queue[id]; return; }
          req = api("POST", "/api/books", {
            id: b.id, workKey: b.workKey || null, title: b.title || "Untitled",
            author: b.author || "Unknown author", year: b.year || null, pages: b.pages || null,
            isbn: b.isbn || null, coverId: b.coverId ? String(b.coverId) : null,
            status: b.status || "want", rating: b.rating || 0, note: b.note || "",
            spineColor: b.spineColor || null, accentColor: b.accentColor || null,
            addedAt: b.addedAt || Date.now(), updatedAt: b.updatedAt || Date.now()
          });
        } else {
          req = api("DELETE", "/api/books?id=" + encodeURIComponent(id));
        }
        return req.then(function (res) {
          if (res.status === 401) throw new AuthError();
          if (res.ok) {
            if (queue[id] && queue[id].at === op.at) delete queue[id];
            if (op.t === "put") syncedIds[id] = 1; else delete syncedIds[id];
          } else if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
            console.warn("Dropping unsyncable change", id, res.status);
            delete queue[id];
          } else {
            throw new Error("HTTP " + res.status);
          }
        });
      });
    });
    return chain.then(function () { persistQueue(); lsSet(LS.synced, syncedIds); },
      function (e) { persistQueue(); lsSet(LS.synced, syncedIds); throw e; });
  }

  function pull() {
    return api("GET", "/api/books").then(function (res) {
      if (res.status === 401) throw new AuthError();
      if (!res.ok || !Array.isArray(res.data)) throw new Error("HTTP " + res.status);

      var S = {}, serverList = res.data.map(normalize);
      serverList.forEach(function (s) { S[s.id] = s; });

      var next = [], changed = false, needPush = false;

      serverList.forEach(function (s) {
        var op = queue[s.id], l = bookMap[s.id];
        if (op && op.t === "del") return;
        if (l) {
          if (op && op.t === "put") next.push(l);
          else if ((s.updatedAt || 0) > (l.updatedAt || 0)) { next.push(s); changed = true; }
          else next.push(l);
        } else { next.push(s); changed = true; }
      });

      books.forEach(function (l) {
        if (S[l.id]) return;
        var op = queue[l.id];
        if (op && op.t === "put") next.push(l);
        else if (syncedIds[l.id]) changed = true;           // deleted on another device
        else { next.push(l); queue[l.id] = { t: "put", at: Date.now() }; needPush = true; }
      });

      syncedIds = {};
      serverList.forEach(function (s) { syncedIds[s.id] = 1; });
      lsSet(LS.synced, syncedIds);

      if (changed || next.length !== books.length) {
        books = next; reindex(); persistBooks(); renderShelf();
        if (openBookId && !bookMap[openBookId]) closeSheet(true);
      }
      if (needPush) { persistQueue(); return flush(); }
    });
  }

  function syncNow() {
    if (!apiMode || !appOpen) return Promise.resolve();
    if (syncRunning) { syncAgain = true; return Promise.resolve(); }
    syncRunning = true;
    clearTimeout(retryTimer);
    setSync("syncing");
    return flush().then(pull).then(function () {
      failCount = 0; lastSync = Date.now();
      setSync("saved");
    }).catch(function (e) {
      if (e && e.auth) { signedOut("Please sign in again."); return; }
      failCount++;
      setSync(navigator.onLine ? "error" : "offline");
      retryTimer = setTimeout(syncNow, Math.min(60000, 2000 * Math.pow(2, failCount - 1)));
    }).then(function () {
      syncRunning = false;
      if (syncAgain) { syncAgain = false; scheduleSync(100); }
    });
  }

  function normalize(b) {
    return {
      id: String(b.id), workKey: b.workKey || null, title: b.title || "Untitled",
      author: b.author || "Unknown author", year: b.year || null, pages: b.pages || null,
      isbn: b.isbn || null, coverId: b.coverId ? String(b.coverId) : null,
      status: STATUS_LABEL[b.status] ? b.status : "want",
      rating: Math.max(0, Math.min(5, parseInt(b.rating, 10) || 0)), note: b.note || "",
      spineColor: b.spineColor || null, accentColor: b.accentColor || null,
      addedAt: b.addedAt || 0, updatedAt: b.updatedAt || 0
    };
  }
  books = books.map(normalize); reindex();

  window.addEventListener("online", function () { failCount = 0; scheduleSync(200); });
  window.addEventListener("offline", function () { if (apiMode) setSync("offline"); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && appOpen && Date.now() - lastSync > 15000) scheduleSync(100);
  });

  // ------------------------------------------------------------------ auth gate
  var authGate = $("authGate"), app = $("app"), authForm = $("authForm");
  var pwInput = $("passwordInput"), authSubmit = $("authSubmit"), authMsg = $("authMsg");
  var lockTimer = null;

  function showGate(message) {
    appOpen = false;
    app.hidden = true;
    authGate.hidden = false;
    closeSheet(true);
    authMsg.className = "auth-msg" + (message ? " info" : "");
    authMsg.textContent = message || "";
    setTimeout(function () { if (!pwInput.disabled) pwInput.focus(); }, 120);
  }
  function openApp() {
    authGate.hidden = true;
    app.hidden = false;
    appOpen = true;
    renderShelf();
    if (window.innerWidth > 700 && !openBookId) {
      setTimeout(function () { $("searchInput").focus({ preventScroll: true }); }, 350);
    }
  }
  function signedOut(message) {
    lsDel(LS.hint);
    showGate(message);
  }

  function lockFor(seconds) {
    var until = Date.now() + seconds * 1000;
    pwInput.disabled = true; authSubmit.disabled = true;
    (function tick() {
      var left = Math.ceil((until - Date.now()) / 1000);
      if (left > 0) {
        authMsg.className = "auth-msg info";
        authMsg.textContent = "Too many attempts. Try again in " + left + "s";
        lockTimer = setTimeout(tick, 500);
      } else {
        pwInput.disabled = false; authSubmit.disabled = false;
        authMsg.textContent = "";
        pwInput.focus();
      }
    })();
  }

  authForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var val = pwInput.value.trim();
    if (!val || pwInput.disabled) return;
    authSubmit.disabled = true;
    authMsg.className = "auth-msg info";
    authMsg.textContent = "";
    api("POST", "/api/auth", { password: val }).then(function (res) {
      authSubmit.disabled = false;
      if (res.ok) {
        lsSet(LS.hint, "1");
        pwInput.value = "";
        authMsg.textContent = "";
        openApp();
        scheduleSync(0);
        return;
      }
      pwInput.value = "";
      if (res.status === 429) {
        lockFor((res.data && res.data.retryAfter) || 45);
      } else if (res.status === 401) {
        authMsg.className = "auth-msg";
        authMsg.textContent = "Incorrect password" + (res.data && res.data.attempts ? " (" + res.data.attempts + "/" + res.data.max + ")" : "");
        authForm.classList.remove("shake"); void authForm.offsetWidth; authForm.classList.add("shake");
        pwInput.focus();
      } else {
        authMsg.className = "auth-msg";
        authMsg.textContent = "Something went wrong. Please try again.";
      }
    }, function () {
      authSubmit.disabled = false;
      authMsg.className = "auth-msg";
      authMsg.textContent = "Can't reach the server. Check your connection.";
    });
  });

  function boot() {
    var hint = lsGet(LS.hint, null) === "1";
    if (hint) openApp(); else showGate();

    api("GET", "/api/auth").then(function (res) {
      if (res.status === 404 || !res.isJson) {
        // Pure static hosting: no server, no password gate; data stays on this device.
        apiMode = false;
        setSync("local");
        if (!appOpen) openApp();
        return;
      }
      if (res.data && res.data.authed) {
        lsSet(LS.hint, "1");
        if (!appOpen) openApp();
        scheduleSync(0);
      } else if (hint || appOpen) {
        signedOut();
      }
    }, function () {
      // Offline or server unreachable
      if (hint) { setSync("offline"); scheduleSync(4000); }
      else { authMsg.className = "auth-msg"; authMsg.textContent = "You're offline. Connect to sign in."; }
    });
  }

  // ------------------------------------------------------------------ filters / sort
  var chips = document.querySelectorAll(".filter-chip");
  var sortTrigger = $("sortTrigger"), sortMenu = $("sortMenu"), sortLabel = $("sortLabel");
  var SORT_NAMES = { added: "Recently added", title: "Title", author: "Author", rating: "Rating" };

  function syncFilterUI() {
    chips.forEach(function (c) { c.classList.toggle("active", c.getAttribute("data-filter") === currentFilter); });
    sortLabel.textContent = SORT_NAMES[currentSort] || SORT_NAMES.added;
    sortMenu.querySelectorAll(".sort-option").forEach(function (o) {
      var on = o.getAttribute("data-sort") === currentSort;
      o.classList.toggle("active", on);
      o.setAttribute("aria-checked", on ? "true" : "false");
    });
  }
  syncFilterUI();

  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      currentFilter = chip.getAttribute("data-filter");
      savePrefs(); syncFilterUI(); renderShelf();
    });
  });

  function setSortOpen(open) {
    sortMenu.classList.toggle("open", open);
    sortTrigger.setAttribute("aria-expanded", open ? "true" : "false");
  }
  sortTrigger.addEventListener("click", function (e) { e.stopPropagation(); setSortOpen(!sortMenu.classList.contains("open")); });
  sortMenu.addEventListener("click", function (e) {
    var opt = e.target.closest(".sort-option");
    if (!opt) return;
    currentSort = opt.getAttribute("data-sort");
    savePrefs(); syncFilterUI(); setSortOpen(false); renderShelf();
    sortTrigger.focus();
  });

  function visibleBooks() {
    var list = books;
    if (currentFilter !== "all") list = list.filter(function (b) { return b.status === currentFilter; });
    else list = list.slice();
    list.sort(function (a, b) {
      if (currentSort === "title") return String(a.title).localeCompare(String(b.title));
      if (currentSort === "author") return String(a.author).localeCompare(String(b.author)) || String(a.title).localeCompare(String(b.title));
      if (currentSort === "rating") return (b.rating || 0) - (a.rating || 0) || (b.addedAt || 0) - (a.addedAt || 0);
      return (b.addedAt || 0) - (a.addedAt || 0);
    });
    return list;
  }

  // ------------------------------------------------------------------ search
  var searchInput = $("searchInput"), resultsBox = $("resultsBox");
  var searchTimer = null, searchCtrl = null, searchCache = {};
  var currentDocs = [], activeIdx = -1;

  function setResultsOpen(open) {
    resultsBox.classList.toggle("open", open);
    searchInput.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open) activeIdx = -1;
  }
  function resultsNote(text) {
    resultsBox.innerHTML = '<div class="result-item note">' + esc(text) + "</div>";
    setResultsOpen(true);
  }

  searchInput.addEventListener("input", function () {
    var q = searchInput.value.trim();
    clearTimeout(searchTimer);
    if (searchCtrl) searchCtrl.abort();
    if (q.length < 2) { setResultsOpen(false); resultsBox.innerHTML = ""; return; }
    searchTimer = setTimeout(function () { runSearch(q); }, 300);
  });
  searchInput.addEventListener("focus", function () {
    if (resultsBox.children.length && searchInput.value.trim().length >= 2) setResultsOpen(true);
  });
  searchInput.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { setResultsOpen(false); return; }
    var items = resultsBox.querySelectorAll(".result-item[data-i]");
    if (!items.length || !resultsBox.classList.contains("open")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = e.key === "ArrowDown" ? (activeIdx + 1) % items.length : (activeIdx - 1 + items.length) % items.length;
      items.forEach(function (it, i) { it.classList.toggle("active", i === activeIdx); });
      items[activeIdx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      addFromResult(activeIdx);
    }
  });

  function runSearch(q) {
    var key = q.toLowerCase();
    if (searchCache[key]) { renderResults(searchCache[key]); return; }
    resultsNote("Searching…");
    searchCtrl = new AbortController();
    var ctrl = searchCtrl;
    var timeout = setTimeout(function () { ctrl.abort(); }, 9000);
    var url = "https://openlibrary.org/search.json?q=" + encodeURIComponent(q) +
      "&limit=10&fields=key,title,author_name,first_publish_year,cover_i,number_of_pages_median,isbn";
    fetch(url, { signal: ctrl.signal }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      clearTimeout(timeout);
      var docs = (data.docs || []).map(function (d) {
        return {
          key: d.key, title: d.title, author_name: d.author_name,
          first_publish_year: d.first_publish_year, cover_i: d.cover_i,
          number_of_pages_median: d.number_of_pages_median,
          isbn: d.isbn && d.isbn[0] ? [d.isbn[0]] : null
        };
      });
      searchCache[key] = docs;
      if (searchInput.value.trim().toLowerCase() === key) renderResults(docs);
    }).catch(function (err) {
      clearTimeout(timeout);
      if (ctrl !== searchCtrl) return;                         // superseded by a newer search
      if (err && err.name === "AbortError" && searchInput.value.trim().toLowerCase() !== key) return;
      resultsNote("Could not reach Open Library. Try again.");
    });
  }

  function alreadyHave(key) {
    for (var i = 0; i < books.length; i++) if (books[i].workKey === key) return true;
    return false;
  }

  function renderResults(docs) {
    currentDocs = docs;
    activeIdx = -1;
    if (!docs.length) { resultsNote("No matches"); return; }
    var html = "";
    docs.forEach(function (doc, i) {
      var have = alreadyHave(doc.key);
      var sub = (doc.author_name ? doc.author_name.join(", ") : "Unknown author") +
        (doc.first_publish_year ? " · " + doc.first_publish_year : "");
      html += '<div class="result-item" role="option" data-i="' + i + '">' +
        (doc.cover_i
          ? '<img class="result-cover" alt="" loading="lazy" decoding="async" src="https://covers.openlibrary.org/b/id/' + doc.cover_i + '-S.jpg">'
          : '<span class="result-cover"></span>') +
        '<div class="result-text"><div class="rt-title">' + esc(doc.title || "Untitled") + '</div>' +
        '<div class="rt-sub">' + esc(sub) + '</div></div>' +
        '<button type="button" class="add-btn' + (have ? " added" : "") + '" tabindex="-1">' + (have ? "Added" : "Add") + "</button></div>";
    });
    resultsBox.innerHTML = html;
    setResultsOpen(true);
  }

  resultsBox.addEventListener("click", function (e) {
    var item = e.target.closest(".result-item[data-i]");
    if (!item) return;
    addFromResult(parseInt(item.getAttribute("data-i"), 10));
  });
  resultsBox.addEventListener("mousemove", function (e) {
    var item = e.target.closest(".result-item[data-i]");
    if (!item) return;
    var i = parseInt(item.getAttribute("data-i"), 10);
    if (i !== activeIdx) {
      activeIdx = i;
      resultsBox.querySelectorAll(".result-item").forEach(function (it) { it.classList.toggle("active", it === item); });
    }
  });

  document.addEventListener("click", function (e) {
    if (!$("searchRow").contains(e.target)) setResultsOpen(false);
    if (!sortMenu.contains(e.target) && e.target !== sortTrigger && !sortTrigger.contains(e.target)) setSortOpen(false);
  });

  function addFromResult(i) {
    var doc = currentDocs[i];
    if (!doc) return;
    if (alreadyHave(doc.key)) {
      toast("Already on your shelf");
      setResultsOpen(false);
      return;
    }
    addBook(doc);
    setResultsOpen(false);
    searchInput.value = "";
    resultsBox.innerHTML = "";
    if (currentFilter !== "all" && currentFilter !== "want") {
      currentFilter = "all"; savePrefs(); syncFilterUI(); renderShelf();
    }
  }

  function addBook(doc) {
    var now = Date.now();
    var book = normalize({
      id: "b_" + now + "_" + Math.floor(Math.random() * 100000),
      workKey: doc.key, title: doc.title || "Untitled",
      author: doc.author_name ? doc.author_name.join(", ") : "Unknown author",
      year: doc.first_publish_year || null, pages: doc.number_of_pages_median || null,
      isbn: (doc.isbn && doc.isbn[0]) || null, coverId: doc.cover_i ? String(doc.cover_i) : null,
      status: "want", rating: 0, note: "", addedAt: now, updatedAt: now,
      spineColor: pickPastel(doc.key), accentColor: null
    });
    books.unshift(book);
    justAdded = book.id;
    commit(book);
    toast("Added “" + book.title + "”");
    if (book.coverId) {
      extractAccent(coverUrl(book.coverId, "M")).then(function (color) {
        if (!color || !bookMap[book.id]) return;
        book.accentColor = color;
        commit(book);
      });
    }
  }

  // ------------------------------------------------------------------ colour from cover
  function extractAccent(url) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () {
        try {
          var c = document.createElement("canvas");
          c.width = 32; c.height = 32;
          var ctx = c.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 32, 32);
          var data = ctx.getImageData(0, 0, 32, 32).data, buckets = {};
          for (var i = 0; i < data.length; i += 4) {
            var r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
            if (a < 120) continue;
            var br = (r + g + b) / 3;
            if (br > 230 || br < 30) continue;
            var max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (max - min < 18) continue;
            var k = (r >> 4) + "," + (g >> 4) + "," + (b >> 4);
            var bk = buckets[k] || (buckets[k] = { r: 0, g: 0, b: 0, n: 0, sat: 0 });
            bk.r += r; bk.g += g; bk.b += b; bk.n++; bk.sat += (max - min) / max;
          }
          var best = null, bestScore = 0;
          Object.keys(buckets).forEach(function (k) {
            var bk = buckets[k], score = bk.n * (0.6 + bk.sat / bk.n);
            if (score > bestScore) { best = bk; bestScore = score; }
          });
          resolve(best ? "rgb(" + Math.round(best.r / best.n) + "," + Math.round(best.g / best.n) + "," + Math.round(best.b / best.n) + ")" : null);
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = url;
    });
  }

  // ------------------------------------------------------------------ the shelf
  var shelfArea = $("shelfArea"), countLabel = $("countLabel");
  var GAP = 2;

  function scaleFor(width) { return clamp(width / 760, 0.84, 1.12); }

  function spineMetrics(b, s) {
    var pages = b.pages || 0;
    var w = Math.round((pages ? 30 + Math.min(26, pages / 46) : 34) * s);
    var h = Math.round((112 + (Math.abs(hashStr(b.id + "h")) % 54)) * s);
    return { w: w, h: h };
  }

  function makeSpine(b) {
    var el = document.createElement("button");
    el.type = "button";
    el.className = "spine";
    el.setAttribute("data-id", b.id);
    el.innerHTML = '<span class="spine-text"><span class="st"></span><span class="sa"></span></span><i class="spine-status"></i>';
    return el;
  }

  function updateSpine(el, b, m) {
    var sig = [b.title, b.author, b.status, b.accentColor, b.spineColor, m.w, m.h].join("|");
    if (el._sig === sig) return;
    el._sig = sig;
    var bg = b.accentColor || b.spineColor || "#E3A6A0";
    var light = isLightColor(bg);
    var tilt = ((Math.abs(hashStr(b.id)) % 5) - 2) * 0.55;
    var st = el.firstChild.firstChild, sa = el.firstChild.lastChild;

    el.style.setProperty("--w", m.w + "px");
    el.style.setProperty("--h", m.h + "px");
    el.style.setProperty("--c", bg);
    el.style.setProperty("--fg", light ? "#3A2C2E" : "#ffffff");
    el.style.setProperty("--tilt", tilt + "deg");
    el.style.setProperty("--fs", clamp(9.5 + m.w * 0.05, 10, 13.5).toFixed(1) + "px");
    el.classList.toggle("dark", light);

    st.textContent = b.title || "Untitled";
    sa.textContent = m.w >= 44 ? (b.author || "") : "";
    el.lastChild.className = "spine-status " + (b.status || "want");
    var label = (b.title || "Untitled") + " by " + (b.author || "Unknown author") + " – " + STATUS_LABEL[b.status || "want"];
    el.setAttribute("aria-label", label);
    el.title = (b.title || "Untitled") + (b.author ? " · " + b.author : "");
  }

  var lastShelfWidth = 0;

  function renderShelf() {
    if (!appOpen) return;
    var list = visibleBooks();

    countLabel.textContent = books.length + (books.length === 1 ? " book" : " books");
    var counts = { all: books.length, reading: 0, read: 0, want: 0 };
    books.forEach(function (b) { if (counts[b.status] !== undefined) counts[b.status]++; });
    chips.forEach(function (c) { c.querySelector("b").textContent = counts[c.getAttribute("data-filter")]; });

    // empty states
    if (!list.length) {
      var msg = currentFilter === "all"
        ? '<div class="serif">Your shelf is empty</div><p>Search above and add a book.<br>It will appear here.</p>'
        : '<div class="serif">Nothing in this view</div><p>Try a different filter or add more books.</p>';
      shelfArea.innerHTML = '<div class="shelf-row"><div class="spines" style="--rowh:230px"><div class="empty-shelf">' + msg + '</div></div><div class="plank"></div></div>';
      return;
    }

    // measure available width (same formulas as the CSS clamp()s)
    var vw = window.innerWidth;
    var side = clamp(vw * 0.024, 9, 20), rowPad = clamp(vw * 0.016, 6, 14);
    var avail = shelfArea.clientWidth - 2 * side - 2 * rowPad - 2;
    lastShelfWidth = shelfArea.clientWidth;
    var s = scaleFor(shelfArea.clientWidth);

    // lay books out into rows
    var rows = [], row = null, x = 0;
    list.forEach(function (b) {
      var m = spineMetrics(b, s);
      var need = m.w + (row && row.items.length ? GAP : 0);
      if (!row || x + need > avail) { row = { items: [], tall: 0 }; rows.push(row); x = 0; need = m.w; }
      row.items.push({ b: b, m: m });
      row.tall = Math.max(row.tall, m.h);
      x += need;
    });

    var frag = document.createDocumentFragment(), used = {};
    rows.forEach(function (r) {
      var rowEl = document.createElement("div");
      rowEl.className = "shelf-row";
      var spines = document.createElement("div");
      spines.className = "spines";
      spines.style.setProperty("--rowh", Math.round(r.tall + 40 * s) + "px");
      r.items.forEach(function (it) {
        var el = spineEls[it.b.id] || (spineEls[it.b.id] = makeSpine(it.b));
        updateSpine(el, it.b, it.m);
        if (justAdded === it.b.id) {
          el.classList.add("drop");
          setTimeout(function () { el.classList.remove("drop"); }, 600);
          justAdded = null;
        }
        used[it.b.id] = 1;
        spines.appendChild(el);
      });
      rowEl.appendChild(spines);
      var plank = document.createElement("div");
      plank.className = "plank";
      rowEl.appendChild(plank);
      frag.appendChild(rowEl);
    });
    shelfArea.replaceChildren(frag);

    // forget spines of books that no longer exist
    Object.keys(spineEls).forEach(function (id) { if (!bookMap[id]) delete spineEls[id]; });
  }

  shelfArea.addEventListener("click", function (e) {
    var sp = e.target.closest(".spine");
    if (sp) openSheet(sp.getAttribute("data-id"), sp);
  });

  var rafId = 0;
  if ("ResizeObserver" in window) {
    new ResizeObserver(function () {
      if (Math.abs(shelfArea.clientWidth - lastShelfWidth) < 2) return;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(renderShelf);
    }).observe(shelfArea);
  } else {
    window.addEventListener("resize", function () {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(renderShelf);
    });
  }

  // ------------------------------------------------------------------ detail sheet
  var overlay = $("overlay"), sheet = $("sheet"), stage = sheet.querySelector(".stage");
  var sheetCover = $("sheetCover"), coverFallback = $("coverFallback");
  var sheetTitle = $("sheetTitle"), sheetAuthor = $("sheetAuthor"), sheetMeta = $("sheetMeta");
  var statusPicker = $("statusPicker"), starsRow = $("starsRow"), noteField = $("noteField");
  var removeBtn = $("removeBtn"), lastFocus = null, noteTimer = null, coverToken = 0;

  function applyAccent(color) {
    sheet.style.setProperty("--sheet-accent", color);
    sheet.style.setProperty("--on-accent", fgFor(color));
    sheet.style.setProperty("--fb-fg", fgFor(color));
  }

  function loadCover(book) {
    var token = ++coverToken;
    sheetCover.classList.remove("ready");
    coverFallback.classList.remove("show");
    sheetCover.removeAttribute("src");
    $("fbTitle").textContent = book.title || "Untitled";
    $("fbAuthor").textContent = book.author || "";
    if (!book.coverId) { coverFallback.classList.add("show"); return; }

    var size = (window.devicePixelRatio >= 1.5 || window.innerWidth >= 720) ? "L" : "M";
    var triedPlain = false;
    sheetCover.onload = function () { if (token === coverToken) sheetCover.classList.add("ready"); };
    sheetCover.onerror = function () {
      if (token !== coverToken) return;
      if (!triedPlain) {                       // retry without CORS mode
        triedPlain = true;
        sheetCover.removeAttribute("crossorigin");
        sheetCover.src = coverUrl(book.coverId, size);
      } else {
        coverFallback.classList.add("show");
      }
    };
    sheetCover.crossOrigin = "anonymous";
    sheetCover.src = coverUrl(book.coverId, size);
  }

  function openSheet(bookId, trigger) {
    var book = bookMap[bookId];
    if (!book) return;
    openBookId = bookId;
    lastFocus = trigger || document.activeElement;

    sheetTitle.textContent = book.title || "Untitled";
    sheetAuthor.textContent = book.author || "Unknown author";
    var meta = [];
    if (book.year) meta.push(book.year);
    if (book.pages) meta.push(book.pages + " pages");
    sheetMeta.textContent = meta.join(" · ");
    sheetCover.alt = "Cover of " + (book.title || "book");

    stage.style.setProperty("--bd", clamp((book.pages || 300) / 26, 15, 34).toFixed(1) + "px");
    applyAccent(book.accentColor || book.spineColor || "#E3A6A0");
    loadCover(book);
    updateStatusButtons(book.status);
    updateStars(book.rating);
    noteField.value = book.note || "";
    autoResizeNote();

    overlay.classList.add("open");
    sheet.classList.add("open");
    sheet.setAttribute("aria-hidden", "false");
    document.body.classList.add("locked");
    sheet.scrollTop = 0;
    setTimeout(function () { sheet.focus({ preventScroll: true }); }, 30);

    if (book.coverId && !book.accentColor) {
      extractAccent(coverUrl(book.coverId, "M")).then(function (color) {
        if (!color || !bookMap[book.id]) return;
        book.accentColor = color;
        commit(book);
        if (openBookId === book.id) applyAccent(color);
      });
    }
  }

  function saveNote() {
    clearTimeout(noteTimer);
    if (!openBookId) return;
    var book = bookMap[openBookId];
    if (book && book.note !== noteField.value) {
      book.note = noteField.value;
      commit(book, { render: false });
    }
  }

  function closeSheet(skipFocus) {
    saveNote();
    overlay.classList.remove("open");
    sheet.classList.remove("open");
    sheet.style.transform = "";
    sheet.setAttribute("aria-hidden", "true");
    document.body.classList.remove("locked");
    var had = openBookId;
    openBookId = null;
    coverToken++;
    if (had && skipFocus !== true && lastFocus && document.contains(lastFocus)) {
      try { lastFocus.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  $("closeSheet").addEventListener("click", function () { closeSheet(); });
  overlay.addEventListener("click", function () { closeSheet(); });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (openBookId) { closeSheet(); return; }
      setSortOpen(false);
    }
    if (e.key === "Tab" && openBookId) {                       // keep focus inside the dialog
      var f = sheet.querySelectorAll("button, textarea, [tabindex]:not([tabindex='-1'])");
      var list = Array.prototype.filter.call(f, function (n) { return n.offsetParent !== null; });
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    if (e.key === "/" && appOpen && !openBookId && !/^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || "")) {
      e.preventDefault(); searchInput.focus();
    }
  });

  statusPicker.addEventListener("click", function (e) {
    var btn = e.target.closest(".status-btn");
    if (!btn || !openBookId) return;
    var book = bookMap[openBookId];
    book.status = btn.getAttribute("data-status");
    updateStatusButtons(book.status);
    commit(book);
  });
  function updateStatusButtons(status) {
    statusPicker.querySelectorAll(".status-btn").forEach(function (b) {
      var on = b.getAttribute("data-status") === status;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  starsRow.addEventListener("click", function (e) {
    var star = e.target.closest(".star");
    if (!star || !openBookId) return;
    var val = parseInt(star.getAttribute("data-val"), 10);
    var book = bookMap[openBookId];
    book.rating = book.rating === val ? 0 : val;
    updateStars(book.rating);
    commit(book);
  });
  function updateStars(rating) {
    starsRow.querySelectorAll(".star").forEach(function (s) {
      var val = parseInt(s.getAttribute("data-val"), 10);
      s.classList.toggle("filled", val <= rating);
      s.setAttribute("aria-pressed", val === rating ? "true" : "false");
    });
  }

  function autoResizeNote() {
    noteField.style.height = "auto";
    noteField.style.height = Math.min(noteField.scrollHeight + 2, 240) + "px";
  }
  noteField.addEventListener("input", function () {
    autoResizeNote();
    clearTimeout(noteTimer);
    noteTimer = setTimeout(saveNote, 700);                    // autosave while typing
  });
  noteField.addEventListener("blur", saveNote);

  removeBtn.addEventListener("click", function () {
    if (!openBookId) return;
    var id = openBookId, snapshot = bookMap[id];
    if (!snapshot) return;
    clearTimeout(noteTimer);
    books = books.filter(function (b) { return b.id !== id; });
    delete bookMap[id];
    persistBooks();
    queue[id] = { t: "del", at: Date.now() };
    persistQueue();
    closeSheet(true);
    renderShelf();
    scheduleSync(500);
    toast("Removed “" + snapshot.title + "”", "Undo", function () {
      books.unshift(snapshot);
      bookMap[snapshot.id] = snapshot;
      commit(snapshot);                                       // supersedes the queued delete
    }, 6000);
  });

  // swipe the handle down to dismiss (phones)
  (function () {
    var handle = $("sheetHandle"), drag = null;
    handle.addEventListener("pointerdown", function (e) {
      if (window.innerWidth >= 720 && !(window.innerHeight < 560)) return;
      drag = { y: e.clientY, t: Date.now(), dy: 0 };
      sheet.classList.add("dragging");
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    });
    handle.addEventListener("pointermove", function (e) {
      if (!drag) return;
      drag.dy = Math.max(0, e.clientY - drag.y);
      sheet.style.transform = "translateY(" + drag.dy + "px)";
    });
    function end() {
      if (!drag) return;
      var d = drag; drag = null;
      sheet.classList.remove("dragging");
      var v = d.dy / Math.max(1, Date.now() - d.t);
      if (d.dy > 110 || (d.dy > 30 && v > 0.6)) closeSheet(); else sheet.style.transform = "";
    }
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  })();

  // ------------------------------------------------------------------ go
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }
  boot();
})();
