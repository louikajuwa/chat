(function () {
  'use strict';
  var $ = Chat.$;
  var socket = io();

  var state = {
    rooms: new Map(), // room -> meta
    currentRoom: null,
    hasMoreRooms: false,
    loadingMoreRooms: false,
  };

  // ---------- Refs ----------
  var drawer = $('drawer');
  var drawerOverlay = $('drawer-overlay');
  var drawerToggle = $('drawer-toggle');
  var drawerClose = $('drawer-close');
  var backToRooms = $('back-to-rooms');
  var topbar = $('topbar');
  var mainPanel = $('main');
  var roomListEl = $('room-list');
  var roomListContainer = $('room-list-container');
  var roomsEmpty = $('rooms-empty');
  var roomsLoading = $('rooms-loading');
  var chatEmpty = $('chat-empty');
  var chatView = $('chat-view');
  var chatTitle = $('chat-title');
  var chatSubtitle = $('chat-subtitle');
  var messagesStatus = $('messages-status');

  // ---------- Auth ----------
  // Logout revokes the session server-side, which also sends this socket 'unauthorized';
  // don't turn our own logout into a "session expired" redirect.
  var loggingOut = false;
  $('logout-form').addEventListener('submit', function () { loggingOut = true; });
  function redirectToLogin() {
    if (!loggingOut) location.href = '/login.html?error=expired';
  }
  Chat.onUnauthorized = redirectToLogin;
  socket.on('unauthorized', redirectToLogin);

  function handleError(err, fallback) {
    if (err && err.code === 'UNAUTHORIZED') { redirectToLogin(); return; }
    Chat.toastError((err && err.message) || fallback || 'Something went wrong');
  }

  // ---------- Drawer (mobile) ----------
  var mq = window.matchMedia('(min-width: 768px)');
  var drawerOpen = false;
  var opener = null;

  function syncDrawer() {
    var mobile = !mq.matches;
    var open = mobile && drawerOpen;
    drawer.classList.toggle('open', open);
    drawer.inert = mobile && !open;
    mainPanel.inert = open;
    topbar.inert = open;
    drawerOverlay.classList.toggle('hidden', !open);
    drawerToggle.setAttribute('aria-expanded', String(open));
    backToRooms.setAttribute('aria-expanded', String(open));
  }
  function openDrawer(from) {
    if (mq.matches) return;
    opener = from || drawerToggle;
    drawerOpen = true;
    syncDrawer();
    drawerClose.focus();
  }
  function closeDrawer() {
    if (!drawerOpen) return;
    drawerOpen = false;
    syncDrawer();
    if (!mq.matches) (opener && opener.offsetParent !== null ? opener : drawerToggle).focus();
  }
  drawerToggle.addEventListener('click', function () { openDrawer(drawerToggle); });
  backToRooms.addEventListener('click', function () { openDrawer(backToRooms); });
  drawerClose.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
  if (mq.addEventListener) mq.addEventListener('change', function () { drawerOpen = false; syncDrawer(); });
  else if (mq.addListener) mq.addListener(function () { drawerOpen = false; syncDrawer(); });
  syncDrawer();

  // ---------- Room cards ----------
  function renderCard(card, meta) {
    var isActive = state.currentRoom === meta.room;
    var unread = !!meta.has_unread && !isActive;
    var preview = meta.last_attachment ? 'Attachment' : meta.last_message || 'No messages yet';

    card.className =
      'block w-full text-left p-3 min-h-[56px] rounded-xl border mb-2 transition-colors ' +
      (isActive ? 'border-ink bg-paper' : 'border-line bg-white hover:border-ink/40');
    if (isActive) card.setAttribute('aria-current', 'true');
    else card.removeAttribute('aria-current');

    var top = Chat.el('div', 'flex items-start justify-between gap-2 mb-0.5');
    top.appendChild(Chat.el('div', 'font-semibold text-sm truncate flex-1 min-w-0', meta.sender_name || 'Guest'));
    if (unread) {
      var dot = Chat.el('span', 'flex-shrink-0 mt-1.5');
      dot.appendChild(Chat.el('span', 'block w-2 h-2 rounded-full bg-accent'));
      dot.appendChild(Chat.el('span', 'sr-only', 'Unread'));
      top.appendChild(dot);
    }
    card.replaceChildren(
      top,
      Chat.el('div', 'text-xs truncate ' + (unread ? 'text-ink font-medium' : 'text-muted'), preview),
      Chat.el('div', 'text-[11px] text-muted mt-1 truncate', meta.room)
    );
  }

  function buildOrUpdateRoomCard(meta) {
    var card = roomListEl.querySelector('[data-room="' + CSS.escape(meta.room) + '"]');
    var isNew = !card;
    if (isNew) {
      card = document.createElement('button');
      card.dataset.room = meta.room;
      card.type = 'button';
      card.addEventListener('click', function () {
        if (state.currentRoom !== meta.room) selectRoom(meta.room);
        closeDrawer();
        if (!mq.matches) return;
        $('message-input').focus();
      });
    }
    state.rooms.set(meta.room, meta);
    renderCard(card, meta);
    return { card: card, isNew: isNew };
  }

  function toggleRoomsEmpty() { roomsEmpty.classList.toggle('hidden', state.rooms.size > 0); }

  function fillRoomsIfShort() {
    requestAnimationFrame(function () {
      var c = roomListContainer;
      if (c.clientHeight > 0 && c.scrollHeight <= c.clientHeight + 1) loadMoreRooms();
    });
  }

  function setRoomList(rooms, hasMore) {
    state.rooms.clear();
    roomListEl.textContent = '';
    rooms.forEach(function (meta) { roomListEl.appendChild(buildOrUpdateRoomCard(meta).card); });
    state.hasMoreRooms = hasMore;
    toggleRoomsEmpty();
    fillRoomsIfShort();
  }

  function appendRoomList(rooms, hasMore) {
    var added = 0;
    rooms.forEach(function (meta) {
      if (state.rooms.has(meta.room)) return;
      roomListEl.appendChild(buildOrUpdateRoomCard(meta).card);
      added++;
    });
    state.hasMoreRooms = hasMore && added > 0;
    toggleRoomsEmpty();
    fillRoomsIfShort();
  }

  function upsertRoomToTop(meta) {
    var r = buildOrUpdateRoomCard(meta);
    var hadFocus = document.activeElement === r.card;
    if (!r.isNew && r.card.parentNode === roomListEl) roomListEl.removeChild(r.card);
    roomListEl.prepend(r.card);
    if (hadFocus) r.card.focus();
    toggleRoomsEmpty();
  }

  function endRoomsLoad() {
    state.loadingMoreRooms = false;
    roomsLoading.classList.add('hidden');
  }

  function loadMoreRooms() {
    if (state.loadingMoreRooms || !state.hasMoreRooms || state.rooms.size === 0) return;
    state.loadingMoreRooms = true;
    roomsLoading.classList.remove('hidden');
    var minId = Infinity;
    state.rooms.forEach(function (m) { if (m.id < minId) minId = m.id; });
    Chat.emitWithAck(socket, 'adminLoadMoreRooms', { beforeId: minId }).catch(function (err) {
      endRoomsLoad();
      handleError(err, 'Could not load more conversations.');
    });
  }

  roomListContainer.addEventListener('scroll', function () {
    var c = roomListContainer;
    if (c.scrollHeight - c.scrollTop - c.clientHeight < 80) loadMoreRooms();
  });

  // ---------- Messages ----------
  var list = Chat.createMessageList({
    container: $('messages-container'),
    list: $('messages'),
    loadingEl: $('messages-loading'),
    isMine: function (m) { return m.from_admin === undefined ? m.sender_name === 'Admin' : !!m.from_admin; },
    label: function (m, mine) { return mine ? 'You' : m.sender_name || 'Guest'; },
    requestMore: function (beforeId) {
      return Chat.emitWithAck(socket, 'adminLoadMoreMessages', { room: state.currentRoom, beforeId: beforeId });
    },
  });

  var composer = Chat.createComposer({
    form: $('chat-form'),
    input: $('message-input'),
    fileInput: $('file-input'),
    chip: $('file-chip'),
    chipName: $('file-chip-name'),
    chipRemove: $('file-chip-remove'),
    sendBtn: $('send-btn'),
    counter: $('char-count'),
    getKey: function () { return state.currentRoom; },
    send: function (payload, room) {
      if (!room) return Promise.reject(new Error('Select a conversation first.'));
      var msg = { room: room };
      if (payload.message) msg.message = payload.message;
      if (payload.file) msg.file = payload.file;
      return Chat.emitWithAck(socket, 'adminMessage', msg, 30000);
    },
  });
  Chat.watchConnection(socket, function (up) { composer.setConnected(up); });

  function setStatus(text) {
    messagesStatus.textContent = text || '';
    messagesStatus.classList.toggle('hidden', !text);
  }

  // ---------- Room selection ----------
  function selectRoom(room) {
    state.currentRoom = room;
    list.reset();
    composer.clear();
    setStatus('Loading conversation…');
    var meta = state.rooms.get(room);
    chatTitle.textContent = (meta && meta.sender_name) || 'Guest';
    chatSubtitle.textContent = room;
    chatEmpty.classList.add('hidden');
    chatView.classList.remove('hidden');
    state.rooms.forEach(function (m) { buildOrUpdateRoomCard(m); });
    Chat.emitWithAck(socket, 'adminSelectRoom', { room: room }).catch(function (err) {
      if (state.currentRoom !== room) return;
      setStatus('Could not load this conversation.');
      handleError(err, 'Could not open this conversation.');
    });
  }

  // ---------- Socket events ----------
  socket.on('connect', async function () {
    try {
      await Chat.emitWithAck(socket, 'adminConnected', {});
    } catch (err) {
      handleError(err, 'Could not connect as admin.');
      return;
    }
    if (state.currentRoom) {
      var room = state.currentRoom;
      Chat.emitWithAck(socket, 'adminSelectRoom', { room: room }).catch(function (err) {
        if (state.currentRoom === room) handleError(err, 'Could not reload this conversation.');
      });
    }
  });

  socket.on('connect_error', function (err) {
    if (err && /unauthorized/i.test(err.message || '')) redirectToLogin();
  });

  socket.on('roomList', function (d) { setRoomList(d.rooms, d.hasMore); });

  socket.on('roomListAppend', function (d) {
    endRoomsLoad();
    appendRoomList(d.rooms, d.hasMore);
  });

  socket.on('roomNew', upsertRoomToTop);

  socket.on('roomUpdate', function (meta) {
    // Active room shouldn't reorder under the user's cursor.
    if (state.currentRoom === meta.room) buildOrUpdateRoomCard(meta);
    else upsertRoomToTop(meta);
  });

  socket.on('chatHistory', function (d) {
    if (d.room !== state.currentRoom) return;
    list.setMessages(d.messages, d.hasMore);
    setStatus(d.messages.length ? '' : 'No messages in this conversation yet.');
  });

  socket.on('chatHistoryAppend', function (d) {
    if (d.room !== state.currentRoom) return;
    list.prepend(d.messages, d.hasMore);
  });

  socket.on('message', function (msg) {
    if (!state.currentRoom || msg.room !== state.currentRoom) return;
    list.append(msg);
    setStatus('');
  });

  socket.on('serverError', function (d) {
    list.cancelLoad();
    endRoomsLoad();
    Chat.toastError((d && d.message) || 'Something went wrong');
  });
})();
