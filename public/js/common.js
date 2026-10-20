/* Shared helpers for guest + admin pages. Exposes window.Chat. */
(function () {
  'use strict';

  var Chat = (window.Chat = {});

  Chat.MAX_MESSAGE_LENGTH = 5000;
  Chat.COUNTER_THRESHOLD = 4500;
  Chat.MAX_FILE_BYTES = 5 * 1024 * 1024;

  var ALLOWED_MIME = {
    'image/png': 1,
    'image/jpeg': 1,
    'image/gif': 1,
    'image/webp': 1,
    'application/pdf': 1,
    'text/plain': 1,
    'application/zip': 1,
    'application/x-zip-compressed': 1,
    'application/msword': 1,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 1,
    'application/vnd.ms-excel': 1,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 1,
  };
  var ALLOWED_EXT = /\.(png|jpe?g|gif|webp|pdf|txt|zip|docx?|xlsx?)$/i;

  // ---------- DOM / text helpers ----------
  Chat.$ = function (id) { return document.getElementById(id); };

  Chat.el = function (tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  };

  Chat.escapeHtml = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  Chat.formatTime = function (d) {
    var date = new Date(d);
    if (isNaN(date.getTime())) return '';
    var sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  Chat.isImagePath = function (p) {
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p || '');
  };

  Chat.fileNameFromPath = function (p) {
    var name = String(p || '').split('?')[0].split('/').pop().replace(/^[a-f0-9]{16}-|^\d{10,}-/, '');
    try { return decodeURIComponent(name) || 'attachment'; } catch { return name || 'attachment'; }
  };

  function safeHref(p) {
    var s = String(p || '');
    return /^(\/(?!\/)|https?:\/\/)/i.test(s) ? s : '#';
  }

  // ---------- Storage (never throws) ----------
  Chat.store = {
    get: function (k) { try { return localStorage.getItem(k); } catch { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    remove: function (k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // ---------- Toasts ----------
  var toastStatus, toastAlert;
  function ensureToasts() {
    if (toastStatus) return;
    var base = 'fixed bottom-4 left-1/2 -translate-x-1/2 max-w-[calc(100vw-2rem)] text-sm px-4 py-2 rounded-2xl shadow-lg opacity-0 pointer-events-none transition-opacity z-50 text-center break-words ';
    toastStatus = Chat.el('div', base + 'bg-ink text-white');
    toastStatus.id = 'toast';
    toastStatus.setAttribute('role', 'status');
    toastStatus.setAttribute('aria-live', 'polite');
    toastAlert = Chat.el('div', base + 'bg-danger text-white');
    toastAlert.id = 'toast-error';
    toastAlert.setAttribute('role', 'alert');
    document.body.appendChild(toastStatus);
    document.body.appendChild(toastAlert);
  }

  Chat.toast = function (msg, opts) {
    ensureToasts();
    var isError = !!(opts && opts.error);
    var node = isError ? toastAlert : toastStatus;
    var other = isError ? toastStatus : toastAlert;
    other.style.opacity = '0';
    node.textContent = msg;
    node.style.opacity = '1';
    clearTimeout(node._t);
    node._t = setTimeout(function () { node.style.opacity = '0'; }, isError ? 5000 : 3000);
  };
  Chat.toastError = function (msg) { Chat.toast(msg, { error: true }); };

  // ---------- Files ----------
  Chat.validateFile = function (file) {
    if (!file) return null;
    if (file.size > Chat.MAX_FILE_BYTES) {
      return '"' + file.name + '" is too large. The maximum file size is 5 MB.';
    }
    if (file.size === 0) return '"' + file.name + '" is empty.';
    var okType = file.type ? !!ALLOWED_MIME[file.type] : ALLOWED_EXT.test(file.name);
    if (!okType) {
      return '"' + file.name + '" is not a supported file type. Allowed: images, PDF, TXT, ZIP, Word, Excel.';
    }
    return null;
  };

  Chat.readFileAsDataURL = function (file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('Could not read the selected file.')); };
      reader.readAsDataURL(file);
    });
  };

  // ---------- Socket ack wrapper ----------
  Chat.emitWithAck = function (socket, event, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      socket.timeout(timeoutMs || 10000).emit(event, payload, function (err, res) {
        if (err) {
          var e = new Error('The request timed out. Please try again.');
          e.code = 'TIMEOUT';
          return reject(e);
        }
        if (res && res.ok === false) {
          var e2 = new Error(res.error || 'Something went wrong.');
          e2.code = res.code;
          return reject(e2);
        }
        resolve(res || { ok: true });
      });
    });
  };

  // ---------- Connection banner ----------
  // Expects <div id="conn-banner" role="status"></div> (kept in DOM so changes are announced).
  Chat.watchConnection = function (socket, onChange) {
    var banner = Chat.$('conn-banner');
    var msgEl = null;
    function set(up, showBanner) {
      if (banner) {
        if (!up && showBanner && !msgEl) {
          msgEl = Chat.el('div', 'bg-ink text-white text-sm text-center px-4 py-2', 'Reconnecting…');
          banner.appendChild(msgEl);
        } else if (up && msgEl) {
          msgEl.remove();
          msgEl = null;
        }
      }
      if (onChange) onChange(up);
    }
    socket.on('connect', function () { set(true); });
    socket.on('disconnect', function () { set(false, true); });
    socket.on('connect_error', function () { set(false, true); });
    set(socket.connected, false);
  };

  // ---------- Message rendering ----------
  var CLIP_ICON =
    '<svg class="w-4 h-4 flex-shrink-0" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path stroke-linecap="round" stroke-linejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32" /></svg>';

  function renderAttachment(path, onMediaLoad) {
    var name = Chat.fileNameFromPath(path);
    var a = Chat.el('a');
    a.href = safeHref(path);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    if (Chat.isImagePath(path)) {
      a.className = 'block mt-1.5 rounded-xl';
      var img = document.createElement('img');
      img.src = safeHref(path);
      img.alt = 'Image attachment: ' + name;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.className = 'block max-w-full max-h-60 w-auto h-auto rounded-xl object-contain';
      img.addEventListener('load', function () { if (onMediaLoad) onMediaLoad(); });
      a.appendChild(img);
    } else {
      a.className = 'inline-flex items-center gap-2 mt-1.5 text-sm underline max-w-full min-h-[24px]';
      a.innerHTML = CLIP_ICON;
      a.appendChild(Chat.el('span', 'min-w-0 break-words [overflow-wrap:anywhere]', name));
    }
    return a;
  }

  /**
   * opts: { mine: boolean, label: string, onMediaLoad: fn }
   * All user content goes through textContent.
   */
  Chat.renderMessage = function (msg, opts) {
    var mine = !!opts.mine;
    var wrap = Chat.el('div', 'flex flex-col mb-3 ' + (mine ? 'items-end' : 'items-start'));
    wrap.dataset.id = msg.id;

    var bubble = Chat.el(
      'div',
      'max-w-[85%] sm:max-w-[70%] min-w-0 rounded-2xl px-4 py-2.5 text-sm leading-relaxed ' +
        (mine ? 'bg-ink text-white' : 'bg-white border border-line text-ink')
    );
    if (msg.message) {
      bubble.appendChild(Chat.el('div', 'whitespace-pre-wrap break-words [overflow-wrap:anywhere]', msg.message));
    }
    if (msg.attachment_path) bubble.appendChild(renderAttachment(msg.attachment_path, opts.onMediaLoad));

    var meta = Chat.el(
      'div',
      'text-[11px] text-muted mt-1 px-1 max-w-[85%] sm:max-w-[70%] truncate',
      opts.label + ' · ' + Chat.formatTime(msg.created_at)
    );
    wrap.appendChild(bubble);
    wrap.appendChild(meta);
    return wrap;
  };

  // ---------- Message list (scroll, pagination, dedupe) ----------
  /**
   * o: { container, list, loadingEl, isMine(msg), label(msg, mine), requestMore(beforeId) -> Promise }
   */
  Chat.createMessageList = function (o) {
    var ids = new Set();
    var oldestId = null;
    var hasMore = false;
    var loading = false;
    var stick = true;
    var gen = 0;

    function nearBottom() {
      var c = o.container;
      return c.scrollHeight - c.scrollTop - c.clientHeight < 100;
    }
    function toBottom() { o.container.scrollTop = o.container.scrollHeight; }
    function busy(on) {
      if (on) o.list.setAttribute('aria-busy', 'true');
      else requestAnimationFrame(function () { o.list.removeAttribute('aria-busy'); });
    }

    function build(msg) {
      if (ids.has(msg.id)) return null;
      ids.add(msg.id);
      oldestId = oldestId == null ? msg.id : Math.min(oldestId, msg.id);
      var mine = o.isMine(msg);
      return Chat.renderMessage(msg, {
        mine: mine,
        label: o.label(msg, mine),
        onMediaLoad: function () { if (stick) toBottom(); },
      });
    }

    function endLoad() {
      loading = false;
      if (o.loadingEl) o.loadingEl.classList.add('hidden');
    }

    function loadMore() {
      if (loading || !hasMore || oldestId == null) return;
      loading = true;
      if (o.loadingEl) o.loadingEl.classList.remove('hidden');
      var myGen = gen;
      o.requestMore(oldestId).catch(function (err) {
        if (myGen !== gen) return;
        endLoad();
        if (err && err.code !== 'UNAUTHORIZED') Chat.toastError(err.message || 'Could not load older messages.');
      });
    }

    function fillIfShort() {
      requestAnimationFrame(function () {
        var c = o.container;
        if (c.clientHeight > 0 && c.scrollHeight <= c.clientHeight + 1 && hasMore) loadMore();
      });
    }

    o.container.addEventListener('scroll', function () {
      stick = nearBottom();
      if (o.container.scrollTop < 80) loadMore();
    });

    return {
      get count() { return ids.size; },
      reset: function () {
        gen++;
        busy(true);
        o.list.textContent = '';
        ids.clear();
        oldestId = null;
        hasMore = false;
        stick = true;
        endLoad();
        busy(false);
      },
      setMessages: function (msgs, more) {
        gen++;
        busy(true);
        o.list.textContent = '';
        ids.clear();
        oldestId = null;
        hasMore = !!more;
        stick = true;
        endLoad();
        var frag = document.createDocumentFragment();
        msgs.forEach(function (m) { var n = build(m); if (n) frag.appendChild(n); });
        o.list.appendChild(frag);
        busy(false);
        requestAnimationFrame(toBottom);
        fillIfShort();
      },
      prepend: function (msgs, more) {
        var c = o.container;
        var prevHeight = c.scrollHeight;
        var prevTop = c.scrollTop;
        busy(true);
        var frag = document.createDocumentFragment();
        var added = 0;
        for (var i = msgs.length - 1; i >= 0; i--) {
          var n = build(msgs[i]);
          if (n) { frag.prepend(n); added++; }
        }
        o.list.prepend(frag);
        c.scrollTop = c.scrollHeight - prevHeight + prevTop;
        hasMore = !!more && added > 0;
        endLoad();
        busy(false);
        fillIfShort();
      },
      append: function (msg) {
        var wasNear = nearBottom();
        var n = build(msg);
        if (!n) return false;
        o.list.appendChild(n);
        stick = wasNear;
        if (wasNear) toBottom();
        return true;
      },
      /** Reset loading flags / indicator (used on serverError). */
      cancelLoad: function () { endLoad(); },
    };
  };

  // ---------- Composer ----------
  /**
   * o: { form, input, fileInput, chip, chipName, chipRemove, sendBtn, counter,
   *      getKey?() -> any (context captured at submit),
   *      send(payload{message?,file?}, key) -> Promise (reject on failure) }
   */
  Chat.createComposer = function (o) {
    var c = { sending: false, connected: false };

    function hasContent() {
      return o.input.value.trim().length > 0 || !!o.fileInput.files[0];
    }
    function autoGrow() {
      o.input.style.height = 'auto';
      o.input.style.height = Math.min(o.input.scrollHeight, 128) + 'px';
    }
    function refresh() {
      o.sendBtn.disabled = c.sending || !c.connected || !hasContent();
      o.sendBtn.classList.toggle('animate-pulse', c.sending);
      o.sendBtn.setAttribute('aria-label', c.sending ? 'Sending…' : 'Send');
      o.form.setAttribute('aria-busy', c.sending ? 'true' : 'false');
      o.input.readOnly = c.sending;
      o.fileInput.disabled = c.sending;
      o.chipRemove.disabled = c.sending;
      var len = o.input.value.length;
      if (o.counter) {
        var show = len >= Chat.COUNTER_THRESHOLD;
        o.counter.classList.toggle('hidden', !show);
        o.counter.textContent = len + ' / ' + Chat.MAX_MESSAGE_LENGTH;
        o.counter.classList.toggle('text-danger', len >= Chat.MAX_MESSAGE_LENGTH);
      }
    }
    function clearFile() {
      o.fileInput.value = '';
      o.chip.classList.add('hidden');
      o.chipName.textContent = '';
    }

    c.clear = function () {
      o.input.value = '';
      clearFile();
      autoGrow();
      refresh();
    };
    c.setConnected = function (up) { c.connected = up; refresh(); };
    c.refresh = refresh;

    o.input.maxLength = Chat.MAX_MESSAGE_LENGTH;
    o.input.addEventListener('input', function () { autoGrow(); refresh(); });
    o.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!c.sending) o.form.requestSubmit();
      }
    });

    o.fileInput.addEventListener('change', function () {
      var f = o.fileInput.files[0];
      if (!f) { clearFile(); refresh(); return; }
      var err = Chat.validateFile(f);
      if (err) {
        clearFile();
        Chat.toastError(err);
      } else {
        o.chipName.textContent = f.name;
        o.chip.classList.remove('hidden');
      }
      refresh();
    });
    o.chipRemove.addEventListener('click', function () {
      clearFile();
      refresh();
      o.input.focus();
    });

    o.form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (c.sending || !c.connected) return;
      var text = o.input.value.trim();
      var file = o.fileInput.files[0];
      if (!text && !file) return;
      var fileErr = Chat.validateFile(file);
      if (fileErr) { clearFile(); refresh(); Chat.toastError(fileErr); return; }

      var key = o.getKey ? o.getKey() : null;
      c.sending = true;
      refresh();
      try {
        var payload = {};
        if (text) payload.message = text;
        if (file) {
          payload.file = { name: file.name, type: file.type, data: await Chat.readFileAsDataURL(file) };
        }
        await o.send(payload, key);
        if (!o.getKey || o.getKey() === key) c.clear();
      } catch (err) {
        if (!err || err.code !== 'UNAUTHORIZED') {
          Chat.toastError((err && err.message) || 'Could not send your message.');
        }
        if (err && err.code === 'UNAUTHORIZED' && Chat.onUnauthorized) Chat.onUnauthorized();
      } finally {
        c.sending = false;
        refresh();
        // A focused send button that got disabled drops focus to <body>; return it to the draft.
        if (document.activeElement === document.body) o.input.focus();
      }
    });

    refresh();
    return c;
  };
})();
