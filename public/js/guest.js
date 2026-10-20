(function () {
  'use strict';
  var $ = Chat.$;
  var socket = io();

  var ROOM_RE = /^room-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  var state = {
    guestName: Chat.store.get('guestName'),
    room: Chat.store.get('room'),
    token: Chat.store.get('guestToken'),
    joined: false,
  };

  // ---------- Refs ----------
  var onboardSection = $('onboard');
  var chatSection = $('chat');
  var onboardForm = $('onboard-form');
  var nameInput = $('name');
  var nameError = $('name-error');
  var meName = $('me-name');
  var quitBtn = $('quit-btn');
  var historyLoading = $('history-loading');
  var emptyHint = $('empty-hint');

  // ---------- Identity ----------
  function randomHex(bytes) {
    return Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(bytes)), function (x) {
      return x.toString(16).padStart(2, '0');
    }).join('');
  }

  function uuidv4() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return x.toString(16).padStart(2, '0'); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function clearIdentity() {
    Chat.store.remove('guestName');
    Chat.store.remove('room');
    Chat.store.remove('guestToken');
    state.guestName = null;
    state.room = null;
    state.token = null;
    state.joined = false;
  }

  function isReserved(name) { return String(name).trim().toLowerCase() === 'admin'; }

  // ---------- Views ----------
  var list = Chat.createMessageList({
    container: $('messages-container'),
    list: $('messages'),
    loadingEl: $('messages-loading'),
    isMine: function (m) {
      return m.from_admin === undefined ? m.sender_name === state.guestName : !m.from_admin;
    },
    label: function (m, mine) { return mine ? 'You' : m.sender_name || 'Support'; },
    requestMore: function (beforeId) {
      return Chat.emitWithAck(socket, 'guestLoadMoreMessages', { room: state.room, beforeId: beforeId });
    },
  });

  function showChat() {
    onboardSection.classList.add('hidden');
    chatSection.classList.remove('hidden');
    meName.textContent = state.guestName;
    if (list.count === 0) {
      historyLoading.classList.remove('hidden');
      emptyHint.classList.add('hidden');
    }
  }

  function showOnboarding(errorMsg) {
    chatSection.classList.add('hidden');
    onboardSection.classList.remove('hidden');
    list.reset();
    composer.clear();
    historyLoading.classList.remove('hidden');
    emptyHint.classList.add('hidden');
    setNameError(errorMsg || '');
    nameInput.focus();
  }

  function setNameError(msg) {
    nameError.textContent = msg;
    nameError.classList.toggle('hidden', !msg);
    nameInput.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg) nameInput.setAttribute('aria-describedby', 'name-error');
    else nameInput.removeAttribute('aria-describedby');
  }

  // ---------- Composer ----------
  var composer = Chat.createComposer({
    form: $('chat-form'),
    input: $('message-input'),
    fileInput: $('file-input'),
    chip: $('file-chip'),
    chipName: $('file-chip-name'),
    chipRemove: $('file-chip-remove'),
    sendBtn: $('send-btn'),
    counter: $('char-count'),
    send: function (payload) {
      if (!state.room || !state.guestName) return Promise.reject(new Error('You are not connected to a chat.'));
      var msg = { room: state.room, guestName: state.guestName };
      if (payload.message) msg.message = payload.message;
      if (payload.file) msg.file = payload.file;
      return Chat.emitWithAck(socket, 'guestMessage', msg, 30000);
    },
  });

  // ---------- Join ----------
  function handleJoinError(message) {
    if (/reserved/i.test(message)) {
      clearIdentity();
      showOnboarding(message || 'That name is reserved');
      return true;
    }
    if (/invalid room/i.test(message)) {
      clearIdentity();
      showOnboarding('Your previous chat is no longer available. Please start a new one.');
      return true;
    }
    return false;
  }

  async function join() {
    if (!state.guestName || !state.room) return;
    try {
      var payload = { guestName: state.guestName, room: state.room };
      if (state.token) payload.token = state.token;
      var res = await Chat.emitWithAck(socket, 'guestConnected', payload);
      // The server only returns a token when it issued one (legacy room claimed without a client token).
      if (res && res.token) {
        state.token = res.token;
        Chat.store.set('guestToken', res.token);
      }
      state.joined = true;
      composer.setConnected(socket.connected);
    } catch (err) {
      if (handleJoinError(err.message)) return;
      Chat.toastError(err.message || 'Could not join the chat.');
      if (err.code === 'TIMEOUT') {
        setTimeout(function () {
          if (socket.connected && !state.joined && state.room) join();
        }, 2000);
      }
    }
  }

  // ---------- Events ----------
  onboardForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = nameInput.value.trim();
    if (!name) { setNameError('Please enter your name.'); nameInput.focus(); return; }
    if (isReserved(name)) { setNameError('That name is reserved'); nameInput.focus(); return; }
    setNameError('');
    var room = 'room-' + uuidv4();
    Chat.store.set('guestName', name);
    Chat.store.set('room', room);
    // Token is generated here (not by the server) so a retried join after a lost ack still matches.
    var token = randomHex(32);
    Chat.store.set('guestToken', token);
    state.guestName = name;
    state.room = room;
    state.token = token;
    state.joined = false;
    showChat();
    $('message-input').focus();
    // If not connected yet, the 'connect' handler sends guestConnected.
    if (socket.connected) join();
  });
  nameInput.addEventListener('input', function () { if (!nameError.classList.contains('hidden')) setNameError(''); });

  quitBtn.addEventListener('click', function () {
    if (!window.confirm('End this chat? Your conversation will no longer be available from this browser.')) return;
    clearIdentity();
    location.reload();
  });

  socket.on('connect', function () {
    // Single place for resume/reconnect join. Server replies with a fresh chatHistory.
    state.joined = false;
    join();
  });
  socket.on('disconnect', function () { state.joined = false; });
  // Composer stays disabled until the server has acknowledged guestConnected.
  Chat.watchConnection(socket, function (up) { composer.setConnected(up && state.joined); });

  socket.on('chatHistory', function (d) {
    if (d.room !== state.room) return;
    historyLoading.classList.add('hidden');
    list.setMessages(d.messages, d.hasMore);
    emptyHint.classList.toggle('hidden', d.messages.length > 0);
  });

  socket.on('chatHistoryAppend', function (d) {
    if (d.room !== state.room) return;
    list.prepend(d.messages, d.hasMore);
  });

  socket.on('message', function (msg) {
    if (msg.room !== state.room) return;
    historyLoading.classList.add('hidden');
    list.append(msg);
    emptyHint.classList.add('hidden');
  });

  socket.on('serverError', function (d) {
    var message = (d && d.message) || 'Something went wrong';
    list.cancelLoad();
    if (!handleJoinError(message)) Chat.toastError(message);
  });

  // ---------- Init ----------
  if (state.room && !ROOM_RE.test(state.room)) clearIdentity();
  if (state.guestName && isReserved(state.guestName)) clearIdentity();
  if (!state.guestName || !state.room) clearIdentity();

  if (state.guestName && state.room) showChat();
  else showOnboarding('');
})();
