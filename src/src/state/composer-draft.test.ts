import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  chipLabel,
  createChipToken,
  draftAttachments,
  draftFromMessage,
  draftProse,
  isChipToken,
  messageSegments,
  pastedFileName,
  pastedMimeType,
  planClipboardPaste,
  splitComposerDraft,
  type ComposerAttachment,
} from './composer-draft.ts'
import type { ChatAttachmentRef } from '../api/session-types.ts'
import { textWithFileMentions } from '../lib/file-mention.ts'

/**
 * The composer's draft: one string that holds the reader's words and the files they carry.
 *
 * What is pinned down here is the pairing itself — a file is one character of the draft, text and
 * files are read back out in the order they were written, and a file the reader backspaced out of the
 * sentence is no longer part of the prompt. The rest of the idea is drawing (a chip is an element
 * built by `components/agents/composer-editor.ts`, which needs a DOM to be checked in).
 */

function file(name: string, token: string): ComposerAttachment {
  return { token, name, path: `C:\\work\\${name}`, mimeType: 'image/png', bytes: 128 }
}

test('a token is one private-use character, and no two files share one', () => {
  const tokens = [createChipToken(), createChipToken(), createChipToken()]
  assert.equal(new Set(tokens).size, tokens.length)
  for (const token of tokens) {
    assert.equal(token.length, 1)
    assert.ok(isChipToken(token))
  }
  assert.equal(isChipToken('a'), false)
  assert.equal(isChipToken('\u200b'), false)
})

test('a draft splits into its words and its files, in the order it wrote them', () => {
  const shot = file('shot.png', '\ue001')
  const notes = file('notes.md', '\ue002')
  const draft = `看这张 \ue001 和 \ue002，谢谢`

  const segments = splitComposerDraft(draft, [shot, notes])
  assert.deepEqual(
    segments.map((segment) => (segment.attachment === null ? segment.text : segment.attachment.name)),
    ['看这张 ', 'shot.png', ' 和 ', 'notes.md', '，谢谢'],
  )
  // The prompt the engine gets: the reader's words with the files' own characters taken out, and the
  // files themselves in the order the sentence named them.
  assert.equal(draftProse(draft), '看这张  和 ，谢谢')
  assert.deepEqual(draftAttachments(draft, [notes, shot]).map((it) => it.name), ['shot.png', 'notes.md'])
})

test('a file the reader backspaced out of the sentence is no longer part of the prompt', () => {
  const shot = file('shot.png', '\ue001')
  assert.deepEqual(draftAttachments(`\ue001 看一下`, [shot]).map((it) => it.name), ['shot.png'])
  // The chip gone, the words left: the record is not named by the draft, so it is not sent.
  assert.deepEqual(draftAttachments('看一下', [shot]), [])
})

test('a private-use character with no file behind it stays the reader’s own text, and never reaches the engine', () => {
  const segments = splitComposerDraft('前\ue009后', [])
  assert.deepEqual(
    segments.map((segment) => segment.text),
    ['前\ue009后'],
  )
  // The range is this application's own vocabulary: whatever is in it is a file's address, so a
  // character with no file behind it is nothing to send.
  assert.equal(draftProse('前\ue009后'), '前后')
})

test('a long name is elided in the label rather than by CSS', () => {
  assert.equal(chipLabel('short.png'), 'short.png')
  const long = 'a-very-long-file-name-for-a-screenshot-taken-today.png'
  const elided = chipLabel(long)
  assert.ok(elided.length < long.length)
  assert.equal(elided, 'a-very-long-file…-today.png')
})

test('a pasted file is named by its leaf, and by this side only when the clipboard had none', () => {
  assert.equal(pastedFileName('C:\\Users\\me\\shot.png', 0), 'shot.png')
  assert.equal(pastedFileName('/home/me/shot.png', 1), 'shot.png')
  assert.equal(pastedFileName('   ', 2), 'pasted-file-3')
  // A clipboard that says nothing about the type is bytes: that is what the desktop stages it as.
  assert.equal(pastedMimeType('image/PNG '), 'image/png')
  assert.equal(pastedMimeType(''), 'application/octet-stream')
})

test('a paste that brought files is read for what it is, not for how many pixels came with it', () => {
  const image = { name: 'shot.png', type: 'image/png' }
  const document = { name: 'notes.pdf', type: 'application/pdf' }

  // A selection copied out of a browser arrives as its text *and* a snapshot of it: the words are
  // what was copied, and the picture is not an attachment anybody asked for.
  assert.deepEqual(planClipboardPaste('一段话', [image]), {
    words: '一段话',
    paths: [],
    importFiles: false,
  })
  // A file copied in Explorer has no words with it: the files are the paste.
  assert.deepEqual(planClipboardPaste('', [image]), { words: '', paths: [], importFiles: true })
  assert.deepEqual(planClipboardPaste('   ', [image]), {
    words: '   ',
    paths: [],
    importFiles: true,
  })
  // Words beside a file that is not a picture are the reader's words *plus* a file they meant to
  // attach, so the files are part of the paste.
  assert.deepEqual(planClipboardPaste('看看这个', [document]), {
    words: '看看这个',
    paths: [],
    importFiles: true,
  })
  assert.deepEqual(planClipboardPaste('看看这个', [image, document]), {
    words: '看看这个',
    paths: [],
    importFiles: true,
  })
  // A clipboard with no file list is words and nothing else.
  assert.deepEqual(planClipboardPaste('看看这个', []), {
    words: '看看这个',
    paths: [],
    importFiles: false,
  })
})

test('a copy made here keeps its files: the words come back without the name written as prose', () => {
  // What this app puts on the clipboard for one message: the words of the selection, then the
  // addresses of the files beside them, with the files themselves as a real list (`lib/clipboard.ts`).
  const copied = textWithFileMentions('history.rs 测试看这张', ['C:\\work\\shot.png'])
  assert.deepEqual(planClipboardPaste(copied, [{ name: 'shot.png', type: 'image/png' }]), {
    words: 'history.rs 测试看这张',
    paths: [],
    importFiles: true,
  })
  // A copy that was nothing but chips is the files, with no sentence left to insert.
  assert.deepEqual(planClipboardPaste('@C:\\work\\shot.png', [{ name: 'shot.png', type: 'image/png' }]), {
    words: '',
    paths: [],
    importFiles: true,
  })
})

test('a copy this page wrote comes back as its own words and its own files, with or without a file list', () => {
  const own = { words: 'history.rs 测试看这张', paths: ['C:\\work\\shot.png'] }
  const copied = textWithFileMentions(own.words, own.paths)

  // The clipboard that reports the copy's text and its file list: the paths are the copy's own, so
  // the files are attached by path and nothing is imported twice.
  assert.deepEqual(planClipboardPaste(copied, [{ name: 'shot.png', type: 'image/png' }], own), {
    words: own.words,
    paths: own.paths,
    importFiles: false,
  })
  // The same copy reported as text alone — which is what a clipboard with no file list on it looks
  // like. This is the cut-then-paste case: the mention lines used to land in the box as prose.
  assert.deepEqual(planClipboardPaste(copied, [], own), {
    words: own.words,
    paths: own.paths,
    importFiles: false,
  })
  // A copy that was nothing but a chip has no words to write, only the file to attach.
  const chipOnly = { words: '', paths: own.paths }
  assert.deepEqual(planClipboardPaste(textWithFileMentions('', own.paths), [], chipOnly), {
    words: '',
    paths: own.paths,
    importFiles: false,
  })
})

/** One file a message carries, as the transcript hands it back: no token, only where it lives. */
function sent(name: string): ChatAttachmentRef {
  return { name, path: `C:\\work\\${name}`, mimeType: 'image/png', bytes: 128 }
}

test('a sent message reads back as its words and its files, paired by position', () => {
  // The message as it was written and sent: the files' characters still in the sentence, and the
  // files in the order the prompt carried them.
  const written = '\ue000看这张 和 \ue001，谢谢'
  const files = [sent('shot.png'), sent('notes.md')]

  assert.deepEqual(
    messageSegments(written, files).map((segment) =>
      segment.attachment === null ? segment.text : segment.attachment.name,
    ),
    ['shot.png', '看这张 和 ', 'notes.md', '，谢谢'],
  )
  // Which code point a file's character happens to be is not part of the pairing: a message read back
  // from the transcript carries the characters the draft was written with, and the files the host's
  // own mention lines named, in the same order.
  assert.deepEqual(
    messageSegments('\ue005看这张', [sent('shot.png')]).map((segment) =>
      segment.attachment === null ? segment.text : segment.attachment.name,
    ),
    ['shot.png', '看这张'],
  )
})

test('a file with no place left to stand is drawn at the end, and a place with no file is dropped', () => {
  // A message sent before the composer kept its characters, or one whose characters were lost: the
  // files it carried are still its files, so they are drawn after the words rather than dropped.
  assert.deepEqual(
    messageSegments('看这张图', [sent('shot.png'), sent('notes.md')]).map((segment) =>
      segment.attachment === null ? segment.text : segment.attachment.name,
    ),
    ['看这张图', 'shot.png', 'notes.md'],
  )
  // The other way round: the range is this application's own vocabulary, so a character in it that
  // stands for no file is not the reader's text and never reaches the screen.
  assert.deepEqual(messageSegments('前\ue009后', []), [{ text: '前后', attachment: null }])
})

test('a message put back into the composer is the draft it was written as', () => {
  // The placeholders are the ones the message was sent with; the restored draft owns new ones, and
  // the files sit where they stood in the words rather than after them.
  const restored = draftFromMessage('看这张 \ue005 和 \ue006，谢谢', [
    sent('shot.png'),
    sent('notes.md'),
  ])
  assert.equal(draftProse(restored.text), '看这张  和 ，谢谢')
  assert.deepEqual(
    draftAttachments(restored.text, restored.attachments).map((it) => it.name),
    ['shot.png', 'notes.md'],
  )
  assert.deepEqual(
    splitComposerDraft(restored.text, restored.attachments).map((segment) =>
      segment.attachment === null ? segment.text : segment.attachment.name,
    ),
    ['看这张 ', 'shot.png', ' 和 ', 'notes.md', '，谢谢'],
  )
})

test('a restored draft takes only the files its room allows', () => {
  const restored = draftFromMessage('\ue005\ue006', [sent('a.png'), sent('b.png')], 1)
  assert.equal(restored.attachments.length, 1)
  assert.deepEqual(restored.attachments.map((it) => it.name), ['a.png'])
  assert.equal(draftProse(restored.text), '')
})
