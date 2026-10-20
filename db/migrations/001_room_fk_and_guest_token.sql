-- Brings pre-existing databases to the schema in chat.sql (fresh installs already have it).
-- Applied once; tracked in schema_migrations.

-- a) match messages.room so the foreign key is possible
ALTER TABLE chat_room MODIFY room VARCHAR(255) NOT NULL;

-- b) guest ownership token (stores only a hash)
ALTER TABLE chat_room ADD COLUMN guest_token_hash CHAR(64) NULL;

-- c) adopt orphan messages as rooms instead of deleting them
INSERT IGNORE INTO chat_room (room, sender_name)
SELECT m.room, MIN(m.sender_name)
FROM messages m LEFT JOIN chat_room c ON c.room = m.room
WHERE c.id IS NULL
GROUP BY m.room;

-- d) referential integrity
ALTER TABLE messages
  ADD CONSTRAINT fk_messages_room FOREIGN KEY (room) REFERENCES chat_room(room)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- e) markRoomRead
ALTER TABLE messages ADD KEY idx_room_unread (room, readMessage);
