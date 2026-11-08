import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  carriesOwnFileMentions,
  fileMentionLine,
  isWrittenCopy,
  promptTextWithFiles,
  textWithFileMentions,
  textWithoutFileMentions,
} from './file-mention.ts'

/**
 * What a copy writes for the files it carries: the host's own mention shape, after the words.
 */

test('a path with a space is quoted and a bare one is not', () => {
  assert.equal(fileMentionLine('C:\\work\\a.txt'), '@C:\\work\\a.txt')
  assert.equal(fileMentionLine('C:\\my work\\a.txt'), '@"C:\\my work\\a.txt"')
})

test('the files are appended after the words, separated by a blank line', () => {
  assert.equal(
    textWithFileMentions('look at this', ['C:\\a.png', 'C:\\b.pdf']),
    'look at this\n\n@C:\\a.png\n@C:\\b.pdf',
  )
})

test('a message that is only files is only their lines', () => {
  assert.equal(textWithFileMentions('   ', ['C:\\a.png']), '@C:\\a.png')
})

test('a file named twice is written once', () => {
  assert.equal(
    textWithFileMentions('x', ['C:\\a.png', 'C:\\a.png']),
    'x\n\n@C:\\a.png',
  )
})

test('a copy with no files is exactly the text', () => {
  assert.equal(textWithFileMentions('unchanged\n', []), 'unchanged\n')
})

/**
 * The inverse: a copy pasted back beside the files it named.
 *
 * WebView2 hands a file-list clipboard to the page as files only (no `text/plain`), so the words
 * are read back from the desktop and the copy's own mention block is dropped for the chips that
 * same paste imports.
 */

test('the mention block of the files this paste carries is dropped', () => {
  assert.equal(
    textWithoutFileMentions('看这张图 描述\n\n@C:\\work\\shot.png', ['shot.png']),
    '看这张图 描述',
  )
  assert.equal(
    textWithoutFileMentions('两个文件\n\n@C:\\a\\shot.png\n@C:\\my work\\notes.pdf', [
      'shot.png',
      'notes.pdf',
    ]),
    '两个文件',
  )
})

test('a copy that was only its files leaves no words to insert', () => {
  assert.equal(textWithoutFileMentions('@C:\\a\\shot.png', ['shot.png']), '')
  assert.equal(textWithoutFileMentions('   \n\n@"C:\\a b\\shot.png"', ['shot.png']), '')
})

test('a block naming a file this paste does not carry is left alone', () => {
  const copied = '看一下\n\n@C:\\a\\shot.png\n@C:\\a\\other.png'
  assert.equal(textWithoutFileMentions(copied, ['shot.png']), copied)
  // The reader's own words that happen to start with @ are not a mention block.
  assert.equal(textWithoutFileMentions('问 @someone 一件事', ['shot.png']), '问 @someone 一件事')
})

test('a paste with no file list cannot strip anything', () => {
  assert.equal(textWithoutFileMentions('words\n\n@C:\\a\\shot.png', []), 'words\n\n@C:\\a\\shot.png')
})

test('a file list that reports the whole path still matches its mention line', () => {
  // What a clipboard reports for the same file can be the leaf or the path it came from; a block
  // naming either one is this paste's own.
  assert.equal(
    textWithoutFileMentions('看\n\n@C:\\a\\shot.png', ['C:\\a\\shot.png']),
    '看',
  )
})

test('the copy this page wrote is recognized by its text, line ends aside', () => {
  const written = textWithFileMentions('看这张', ['C:\\a\\shot.png'])
  assert.equal(isWrittenCopy(written, written), true)
  // `CF_UNICODETEXT` may hand the text back with CRLF line ends; that is the same copy.
  assert.equal(isWrittenCopy(written.replace(/\n/g, '\r\n'), written), true)
  // One character different is a different clipboard — another application's words are never
  // attached as this page's files.
  assert.equal(isWrittenCopy(`${written} `, written), false)
  assert.equal(isWrittenCopy('看这张', written), false)
})

test("a copy's text says whether the files beside it are its own", () => {
  // A copy this app wrote ends with the block naming the files that travel with it.
  assert.equal(carriesOwnFileMentions('看这张\n\n@C:\\a\\shot.png', ['shot.png']), true)
  assert.equal(carriesOwnFileMentions('@C:\\a\\shot.png', ['shot.png']), true)
  // A sentence copied out of a browser has no such block — the picture that came with it is a
  // snapshot, not a file the copy names.
  assert.equal(carriesOwnFileMentions('看这张 shot.png', ['shot.png']), false)
  assert.equal(carriesOwnFileMentions('', ['shot.png']), false)
  // A block naming a file this paste does not carry is not its own.
  assert.equal(carriesOwnFileMentions('看\n\n@C:\\a\\other.png', ['shot.png']), false)
})

/**
 * A prompt's own text, as a dialog submits it: the words and the files in one string.
 *
 * The separator is the thing under test. The desktop writes one line break (`build_prompt`) and the
 * transcript reads the mention lines directly behind the words, so a blank line here would leave
 * every file in the answer behind and the message would come back as prose naming a path.
 */

test('a prompt names its files on the line after the words', () => {
  assert.equal(
    promptTextWithFiles('ship it', ['C:\\a.png', 'C:\\my work\\b.pdf']),
    'ship it\n@C:\\a.png\n@"C:\\my work\\b.pdf"',
  )
})

test("a prompt's trailing blank lines would hide its files, so they go", () => {
  assert.equal(promptTextWithFiles('ship it\n\n', ['C:\\a.png']), 'ship it\n@C:\\a.png')
})

test('an answer that is only files is only their lines', () => {
  assert.equal(promptTextWithFiles('   ', ['C:\\a.png']), '@C:\\a.png')
  assert.equal(promptTextWithFiles('', ['C:\\a.png', 'C:\\a.png']), '@C:\\a.png')
})

test('a prompt with no files is exactly the text it was written with', () => {
  assert.equal(promptTextWithFiles('ship it\n', []), 'ship it\n')
})
