import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const EVENTS = new Set(['wheel', 'touchstart', 'touchmove', 'pointermove']);

interface Registration {
  event: string;
  passive: boolean;
  cancels: boolean;
}

// Only literal event types/options and same-file named or inline handlers are accepted.
// Comments and quoted text cannot be mistaken for calls. Templates are opaque text.
function registrations(source: string): Registration[] {
  const tokens = [...source.matchAll(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[\w$]+|=>|[^\s]/g,
  )].map((match) => match[0]).filter((token) => !token.startsWith('//') && !token.startsWith('/*'));
  const closing = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (['(', '[', '{'].includes(tokens[i])) stack.push(i);
    if ([')', ']', '}'].includes(tokens[i])) {
      const open = stack.pop();
      if (open !== undefined) closing.set(open, i);
    }
  }
  function bodyAfter(start: number): string[] {
    for (let i = start; i < tokens.length; i++) {
      if (tokens[i] === '(' || tokens[i] === '[') i = closing.get(i) ?? i;
      else if (tokens[i] === '{') return tokens.slice(i + 1, closing.get(i));
      else if (tokens[i] === ';') break;
    }
    throw new Error('Unresolved handler body');
  }
  function argumentsAt(open: number): string[][] {
    const args: string[][] = [];
    let start = open + 1;
    const end = closing.get(open);
    if (end === undefined) throw new Error('Unclosed registration');
    for (let i = start; i < end; i++) {
      if (closing.has(i)) i = closing.get(i)!;
      else if (tokens[i] === ',') {
        args.push(tokens.slice(start, i));
        start = i + 1;
      }
    }
    if (start < end) args.push(tokens.slice(start, end));
    return args;
  }
  const functions = new Map<string, string[]>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'function' && tokens[i + 2] === '(') {
      functions.set(tokens[i + 1], bodyAfter(i + 2));
    }
    if (['const', 'let', 'var'].includes(tokens[i]) && tokens[i + 2] === '=') {
      // An arrow's body follows its argument list and optional return annotation.
      let end = i + 3;
      if (tokens[end] === '(') end = (closing.get(end) ?? end) + 1;
      while (tokens[end] === ':' || tokens[end] === 'void') end++;
      if (tokens[end] === '=>') {
        functions.set(tokens[i + 1], tokens[end + 1] === '{'
          ? bodyAfter(end + 1) : tokens.slice(end + 1, tokens.indexOf(';', end)));
      }
    }
  }
  const result: Registration[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'addEventListener' || tokens[i + 1] !== '(') continue;
    const [type, handler, options = []] = argumentsAt(i + 1);
    if (type.length !== 1 || !/^(['"])[\w]+\1$/.test(type[0])) {
      throw new Error('Event type must be a string literal');
    }
    const event = type[0].slice(1, -1);
    if (!EVENTS.has(event)) continue;
    let body = handler;
    if (handler.length === 1) {
      const resolved = functions.get(handler[0]);
      if (!resolved) throw new Error(`Unresolved handler: ${handler[0]}`);
      body = resolved;
    } else if (!handler.includes('=>') && handler[0] !== 'function') {
      throw new Error('Handler must be a local function');
    }
    // Follow calls to local helpers too, without following property methods or recursive cycles.
    function cancels(bodyTokens: string[], visited = new Set<string>()): boolean {
      for (let j = 0; j < bodyTokens.length; j++) {
        const name = bodyTokens[j];
        if (name === 'preventDefault' && bodyTokens[j + 1] === '(') return true;
        if (bodyTokens[j + 1] !== '(' || bodyTokens[j - 1] === '.' || visited.has(name)) continue;
        const helper = functions.get(name);
        if (helper) {
          visited.add(name);
          if (cancels(helper, visited)) return true;
        }
      }
      return false;
    }
    // Reject computed options and spreads: their effective passive flag cannot be proven here.
    let passive = false;
    let depth = 0;
    for (let j = 0; j < options.length; j++) {
      if (depth === 1 && ['passive', "'passive'", '"passive"'].includes(options[j])) {
        passive = options[j + 1] === ':' && options[j + 2] === 'true'
          && [',', '}'].includes(options[j + 3]);
      }
      if (['{', '[', '('].includes(options[j])) depth++;
      if (['}', ']', ')'].includes(options[j])) depth--;
    }
    passive &&= options[0] === '{' && options.at(-1) === '}' && !options.join('').includes('...');
    result.push({
      event,
      passive,
      cancels: cancels(body),
    });
  }
  return result;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

function violations(source: string): string[] {
  return registrations(source).flatMap((row) => [
    ...(!row.passive ? [`${row.event}: passive:true required`] : []),
    ...(row.cancels ? [`${row.event}: handler calls preventDefault`] : []),
    ...(row.event === 'touchmove' ? ['touchmove must stay unregistered'] : []),
  ]);
}

describe('passive input listeners', () => {
  it('keeps every wheel, touchstart and pointermove passive, without cancellation or touchmove', () => {
    const failures = sourceFiles('src').flatMap((file) => {
      try {
        return violations(readFileSync(file, 'utf8')).map((failure) => `${file}: ${failure}`);
      } catch (error) {
        return [`${file}: ${String(error)}`];
      }
    });
    expect(failures).toEqual([]);
  });

  it('rejects missing passive options and cancellation in local or inline handlers', () => {
    expect(violations("el.addEventListener('wheel', () => {});")).toEqual(['wheel: passive:true required']);
    expect(violations("el.addEventListener('pointermove', e => e.preventDefault(), { passive: true });"))
      .toEqual(['pointermove: handler calls preventDefault']);
    expect(violations(`function stop(e) { e.preventDefault(); }
      const move = (e): void => { stop(e); };
      el.addEventListener('pointermove', move, { passive: true });`))
      .toEqual(['pointermove: handler calls preventDefault']);
    expect(violations("el.addEventListener('touchmove', () => {}, { passive: true });"))
      .toEqual(['touchmove must stay unregistered']);
    expect(violations("el.addEventListener('wheel', () => {}, { nested: { passive: true } });"))
      .toEqual(['wheel: passive:true required']);
    expect(violations("el.addEventListener('wheel', () => {}, { passive: true, ...other });"))
      .toEqual(['wheel: passive:true required']);
  });

  it('ignores comments and strings and accepts multiline registrations', () => {
    expect(violations(`// el.addEventListener('wheel', broken);
      function move() { const text = 'preventDefault()'; /* event.preventDefault(); */ }
      el.addEventListener(
        'pointermove', move, { passive: true, capture: false }
      );`)).toEqual([]);
  });

  it('rejects unresolved handlers and event types rather than silently omitting them', () => {
    expect(() => registrations("el.addEventListener('wheel', imported, { passive: true });"))
      .toThrow('Unresolved handler');
    expect(() => registrations('el.addEventListener(type, handler);')).toThrow('Event type must be a string');
  });
});
