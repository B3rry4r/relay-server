import { describe, expect, it } from 'vitest';
import { ScrollbackBuffer } from '../src/relay-server/scrollback';

describe('ScrollbackBuffer', () => {
  it('starts empty', () => {
    const buffer = new ScrollbackBuffer(100);
    expect(buffer.toString()).toBe('');
    expect(buffer.length).toBe(0);
  });

  it('accumulates appended chunks in order', () => {
    const buffer = new ScrollbackBuffer(100);
    buffer.append('hello ');
    buffer.append('world');
    expect(buffer.toString()).toBe('hello world');
    expect(buffer.length).toBe(11);
  });

  it('drops oldest chunks once the byte cap is exceeded', () => {
    const buffer = new ScrollbackBuffer(10);
    buffer.append('aaaaa');     // 5 bytes
    buffer.append('bbbbb');     // 10 bytes total
    buffer.append('ccccc');     // 15 → overflow, drop 'aaaaa'
    expect(buffer.toString()).toBe('bbbbbccccc');
    expect(buffer.length).toBe(10);
  });

  it('truncates a single oversize chunk to the cap', () => {
    const buffer = new ScrollbackBuffer(5);
    buffer.append('abcdefghij');
    expect(buffer.toString()).toBe('fghij');
    expect(buffer.length).toBe(5);
  });

  it('reset replaces contents and trims to the cap', () => {
    const buffer = new ScrollbackBuffer(5);
    buffer.append('xxxxx');
    buffer.reset('1234567890');
    expect(buffer.toString()).toBe('67890');
  });

  it('reset to empty string clears the buffer', () => {
    const buffer = new ScrollbackBuffer(100);
    buffer.append('something');
    buffer.reset('');
    expect(buffer.toString()).toBe('');
    expect(buffer.length).toBe(0);
  });

  it('toString caches subsequent reads until the next append', () => {
    const buffer = new ScrollbackBuffer(100);
    buffer.append('one ');
    buffer.append('two ');
    buffer.append('three');
    const a = buffer.toString();
    const b = buffer.toString();
    expect(a).toBe('one two three');
    // The second call returns the cached value — same reference.
    expect(a).toBe(b);
    buffer.append(' four');
    expect(buffer.toString()).toBe('one two three four');
  });

  it('survives a high-volume append pattern without losing the tail', () => {
    // The original O(n²) code would trip up on this scale; the ring
    // buffer should handle it cheaply and produce a tail of the right
    // length.
    const buffer = new ScrollbackBuffer(1000);
    let sent = '';
    for (let i = 0; i < 5000; i++) {
      const chunk = `chunk-${i}\n`;
      buffer.append(chunk);
      sent += chunk;
    }
    const out = buffer.toString();
    expect(out.length).toBe(1000);
    // The tail should match the last 1000 bytes of what we sent.
    expect(out).toBe(sent.slice(-1000));
  });
});
