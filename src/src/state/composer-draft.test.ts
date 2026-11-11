import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  chipLabel,
  chipPlacements,
  createChipToken,
  draftAttachments,
  draftFromMessage,
  draftProse,
  insertPastedChips,
  isChipToken,
  messagePlacements,
  messageSegments,
  pastedFileName,
  pastedMimeType,
  planClipboardPaste,
  shiftPasteSpan,
  splitComposerDraft,
  type ComposerAttachment,
} from './composer-draft.ts'
import type { ChatAttachmentRef } from '../api/session-types.ts'
import { textWithFileMentions } from '../lib/file-mention.ts'
import { markerOffsets } from '../lib/selection-words.ts'

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
    placements: [],
    importFiles: false,
  })
  // A file copied in Explorer has no words with it: the files are the paste.
  assert.deepEqual(planClipboardPaste('', [image]), {
    words: '',
    paths: [],
    placements: [],
    importFiles: true,
  })
  assert.deepEqual(planClipboardPaste('   ', [image]), {
    words: '   ',
    paths: [],
    placements: [],
    importFiles: true,
  })
  // Words beside a file that is not a picture are the reader's words *plus* a file they meant to
  // attach, so the files are part of the paste.
  assert.deepEqual(planClipboardPaste('看看这个', [document]), {
    words: '看看这个',
    paths: [],
    placements: [],
    importFiles: true,
  })
  assert.deepEqual(planClipboardPaste('看看这个', [image, document]), {
    words: '看看这个',
    paths: [],
    placements: [],
    importFiles: true,
  })
  // A clipboard with no file list is words and nothing else.
  assert.deepEqual(planClipboardPaste('看看这个', []), {
    words: '看看这个',
    paths: [],
    placements: [],
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
    placements: [],
    importFiles: true,
  })
  // A copy that was nothing but chips is the files, with no sentence left to insert.
  assert.deepEqual(planClipboardPaste('@C:\\work\\shot.png', [{ name: 'shot.png', type: 'image/png' }]), {
    words: '',
    paths: [],
    placements: [],
    importFiles: true,
  })
})

test('a copy this page wrote comes back as its own words and its own files, with or without a file list', () => {
  // The offsets are what the clipboard cannot carry: the chip stood at the fifth character of the
  // words, and the page remembers that beside its copy (`lib/clipboard.ts::copyTextWithFiles`).
  const own = {
    words: 'history.rs 测试看这张',
    paths: ['C:\\work\\shot.png'],
    placements: [5],
  }
  const copied = textWithFileMentions(own.words, own.paths)

  // The clipboard that reports the copy's text and its file list: the paths are the copy's own, so
  // the files are attached by path and nothing is imported twice.
  assert.deepEqual(planClipboardPaste(copied, [{ name: 'shot.png', type: 'image/png' }], own), {
    words: own.words,
    paths: own.paths,
    placements: own.placements,
    importFiles: false,
  })
  // The same copy reported as text alone — which is what a clipboard with no file list on it looks
  // like. This is the cut-then-paste case: the mention lines used to land in the box as prose.
  assert.deepEqual(planClipboardPaste(copied, [], own), {
    words: own.words,
    paths: own.paths,
    placements: own.placements,
    importFiles: false,
  })
  // A copy that was nothing but a chip has no words to write, only the file to attach.
  const chipOnly = { words: '', paths: own.paths, placements: [0] }
  assert.deepEqual(planClipboardPaste(textWithFileMentions('', own.paths), [], chipOnly), {
    words: '',
    paths: own.paths,
    placements: chipOnly.placements,
    importFiles: false,
  })
})

test('a copied slice names each chip and the prose offset it stood at', () => {
  const shot = file('shot.png', '\ue001')
  const notes = file('notes.md', '\ue002')
  const sentence = '看这张 \ue001 和 \ue002，谢谢'
  const { paths, placements } = chipPlacements(sentence, [shot, notes])
  assert.deepEqual(paths, [shot.path, notes.path])
  // Prose: `看这张  和 ，谢谢` — four characters before the first chip, seven before the second.
  assert.deepEqual(placements, [4, 7])
  // A token with no record is this application's own character, not one of the reader's: it is
  // dropped from the prose just as `draftProse` drops it, and no chip is named for it.
  assert.deepEqual(chipPlacements('前\ue009后', []), { paths: [], placements: [] })
})

test('a pasted copy writes its chips back where its words carried them', () => {
  const draft = 'Xab cd efY'
  const positions = {
    paths: ['C:\\work\\p.png', 'C:\\work\\q.png'],
    placements: [3, 6],
    start: 1,
    end: 9,
  }
  const records = [
    { token: '\ue001', path: 'C:\\work\\p.png' },
    { token: '\ue002', path: 'C:\\work\\q.png' },
  ]
  // `X` then the pasted words `ab cd ef` then `Y`: the chips stood before `cd` and before `ef`.
  assert.equal(
    insertPastedChips(draft, records, positions),
    'Xab \ue001cd \ue002efY',
  )
  // The answer does not have to arrive in chip order: a record's own path decides its place.
  assert.equal(
    insertPastedChips(draft, [
      { token: '\ue002', path: 'C:\\work\\q.png' },
      { token: '\ue001', path: 'C:\\work\\p.png' },
    ], positions),
    'Xab \ue001cd \ue002efY',
  )
  // A record the copy never named goes at the end of the pasted words, not nowhere.
  assert.equal(
    insertPastedChips(
      draft,
      [...records, { token: '\ue003', path: 'C:\\work\\r.png' }],
      positions,
    ),
    'Xab \ue001cd \ue002ef\ue003Y',
  )
  // An offset past the words is clamped to their end: a copy trims the words' trailing space.
  assert.equal(
    insertPastedChips(draft, [records[0]!], { ...positions, placements: [99] }),
    'Xab cd ef\ue001Y',
  )
  // Two chips at one offset keep the import's order.
  assert.equal(
    insertPastedChips(
      draft,
      records,
      { ...positions, placements: [0, 0], start: 1, end: 9 },
    ),
    'X\ue001\ue002ab cd efY',
  )
})

test('a chip copied out of a sentence pastes back into the same place in another one', () => {
  // The field's own copy: the words without the chip, and the offset the chip stood at.
  const shot = file('shot.png', '\ue001')
  const source = '看这张 \ue001 和后面'
  const chips = chipPlacements(source, [shot])
  const own = {
    words: draftProse(source),
    paths: chips.paths,
    placements: chips.placements,
  }
  const plan = planClipboardPaste(textWithFileMentions(own.words, own.paths), [], own)
  // Pasting `前后`, with the caret between the two characters: the chip belongs between the words'
  // own two spaces, not after `后`.
  const target = '前后'
  const start = 1
  const pasted = `${target.slice(0, start)}${plan.words}${target.slice(start)}`
  assert.equal(
    insertPastedChips(pasted, [{ token: '\ue002', path: shot.path }], {
      paths: plan.paths,
      placements: plan.placements,
      start,
      end: start + plan.words.length,
    }),
    '前看这张 \ue002 和后面后',
  )
})

test('a chip after an astral character keeps its offset in code units', () => {
  const shot = file('shot.png', '\ue001')
  // The emoji is one code point but two UTF-16 units; the draft's slice indices count the units.
  const { paths, placements } = chipPlacements('😀\ue001看', [shot])
  assert.deepEqual(paths, [shot.path])
  assert.deepEqual(placements, [2])
  // Inserting at 2 keeps the emoji's surrogate pair whole.
  assert.equal(
    insertPastedChips('😀看', [{ token: '\ue002', path: shot.path }], {
      paths: [shot.path],
      placements: [2],
      start: 0,
      end: 3,
    }),
    '😀\ue002看',
  )
})

test('an edit outside the pasted words moves their offsets; an edit inside drops them', () => {
  const span = { start: 4, end: 7 }
  // Typing before the block moves it whole.
  assert.deepEqual(shiftPasteSpan(span, '0123456789', 'XX0123456789'), {
    start: 6,
    end: 9,
  })
  // Typing at its start moves it; typing at its end does not.
  assert.deepEqual(shiftPasteSpan(span, '0123456789', '0123X456789'), {
    start: 5,
    end: 8,
  })
  assert.deepEqual(shiftPasteSpan(span, '0123456789', '0123456X789'), span)
  // An edit touching the pasted words makes their offsets describe a string that is gone.
  assert.equal(shiftPasteSpan(span, '0123456789', '0123X56789'), null)
})

test('a message copy derives one offset per attachment from its segments', () => {
  const shot = sent('shot.png')
  const notes = sent('notes.md')
  const segments = messageSegments('看这张 \ue005 和 \ue006，谢谢', [shot, notes])
  assert.deepEqual(messagePlacements(segments), [4, 7])
  // A file with no placeholder left is appended after the words, so both offsets are its end.
  assert.deepEqual(messagePlacements(messageSegments('看这张图', [shot, notes])), [4, 4])
})

test('the field and the transcript put a chip at the same prose offset', () => {
  const shot = file('shot.png', '\ue001')
  // The same sentence read from the draft and from the rendered message: no space before the chip,
  // one after it. The field's draft offset and the feed's marked-run offset must agree.
  const field = chipPlacements('看这张\ue001 和', [shot]).placements[0]
  const feed = markerOffsets(['看这张', ' 和'], '看这张 和')[0]
  assert.equal(field, feed)
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
