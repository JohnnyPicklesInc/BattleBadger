import { describe, expect, it } from 'vitest'
import { inviteLink, normalizeRoomCode, roomFromUrl } from '../src/ui/invite.ts'

// The invite link is the join flow for anyone who did not type a code, so the
// parse is what decides whether a shared URL lands in the right lobby — or in
// a connection attempt to a room that cannot exist.

describe('normalizeRoomCode', () => {
  it('uppercases a 4-letter code', () => {
    expect(normalizeRoomCode('abcd')).toBe('ABCD')
    expect(normalizeRoomCode('  QrSt ')).toBe('QRST')
  })

  it('rejects anything the relay would not route', () => {
    // worker.ts routes /api/rooms/([A-Za-z]{4})/ws and nothing else
    for (const bad of ['', 'ABC', 'ABCDE', 'AB1D', 'AB-D', '../x', null, undefined]) {
      expect(normalizeRoomCode(bad), String(bad)).toBeNull()
    }
  })
})

describe('roomFromUrl', () => {
  it('reads ?room= and #room=', () => {
    expect(roomFromUrl('https://bb.example/?room=ABCD')).toBe('ABCD')
    expect(roomFromUrl('https://bb.example/#room=abcd')).toBe('ABCD')
    expect(roomFromUrl('https://bb.example/?demo=econ&room=WXYZ')).toBe('WXYZ')
  })

  it('is null without a valid room', () => {
    expect(roomFromUrl('https://bb.example/')).toBeNull()
    expect(roomFromUrl('https://bb.example/#editor')).toBeNull()
    expect(roomFromUrl('https://bb.example/?room=nope!')).toBeNull()
    expect(roomFromUrl('not a url')).toBeNull()
  })
})

describe('inviteLink', () => {
  it('keeps the origin and path, and carries only the room', () => {
    expect(inviteLink('https://bb.example/play?demo=econ#editor', 'ABCD')).toBe('https://bb.example/play?room=ABCD')
  })

  it('round-trips through the parser', () => {
    expect(roomFromUrl(inviteLink('http://localhost:5173/', 'QRST'))).toBe('QRST')
  })

  it('replaces the room of a link that already has one', () => {
    expect(inviteLink('https://bb.example/?room=AAAA', 'BBBB')).toBe('https://bb.example/?room=BBBB')
  })
})
