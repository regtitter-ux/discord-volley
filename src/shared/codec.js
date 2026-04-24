"use strict";
// Shared binary Codec: горячий путь relay свёрнут в бинарные WS-фреймы,
// сервер их форвардит без JSON.parse/stringify. Кодек обязан быть общим
// (клиент ↔ Railway-relay ↔ Hathora-room) — wire-format меняется только
// в отдельном PR с миграцией и одновременным деплоем всех нод.
//
// Формат: byte 0 = opcode, дальше payload.
//   0x01 input  — 2 байта.  [1] = биты 0/1/2 = left/right/jump.
//   0x02 state  — 69 байт.  seq:u32 + srvTickMs:u32 + 13× f32 физики +
//                 3× i16 (s1,s2,rh) + 2 flags-байта.
//                 seq и srvTickMs добавлены в Block B (Apr 2026) под
//                 net-diagnostics: клиент вычисляет lostSnapPct по seq-gap
//                 и компенсирует jitter отсортировав по srvTickMs.
//                 Старый формат 61 байт без seq/ts больше не принимается.
//   0x03 emote  — 2 байта.  [1] = id эмоции как uint8 (1..26).
//
// Все числа — little-endian. encodeState переиспользует module-level
// ArrayBuffer (pool of 1) — экономит ~120 alloc/s/match на room-server.
// Caller обязан немедленно передать возвращённый Uint8Array в ws.send():
// ws@8 ставит данные в очередь синхронно, повторный encode перезатрёт буфер.
(function(root){
  const LE = true;
  const STATE_FRAME_BYTES = 69;
  // Pool: один буфер на процесс. Безопасно потому, что encodeState +
  // ws.send образуют синхронную пару — нет шанса, что между ними другой
  // вызов encodeState перезапишет данные (Node single-thread, без await).
  const _stateBuf = new ArrayBuffer(STATE_FRAME_BYTES);
  const _stateDv  = new DataView(_stateBuf);
  const _stateU8  = new Uint8Array(_stateBuf);

  function encodeInput(left, right, jump){
    const u = new Uint8Array(2);
    u[0] = 0x01;
    u[1] = (left?1:0) | (right?2:0) | (jump?4:0);
    return u;
  }

  function encodeState(seq, srvTickMs, p1, p2, ball, s1, s2, rh, mo, ro, ss, w, lh){
    const dv = _stateDv;
    dv.setUint8(0, 0x02);
    dv.setUint32(1, (seq >>> 0),       LE);
    dv.setUint32(5, (srvTickMs >>> 0), LE);
    let o = 9;
    dv.setFloat32(o, p1.x,  LE); o+=4;
    dv.setFloat32(o, p1.y,  LE); o+=4;
    dv.setFloat32(o, p1.vx, LE); o+=4;
    dv.setFloat32(o, p1.vy, LE); o+=4;
    dv.setFloat32(o, p2.x,  LE); o+=4;
    dv.setFloat32(o, p2.y,  LE); o+=4;
    dv.setFloat32(o, p2.vx, LE); o+=4;
    dv.setFloat32(o, p2.vy, LE); o+=4;
    dv.setFloat32(o, ball.x,     LE); o+=4;
    dv.setFloat32(o, ball.y,     LE); o+=4;
    dv.setFloat32(o, ball.vx,    LE); o+=4;
    dv.setFloat32(o, ball.vy,    LE); o+=4;
    dv.setFloat32(o, ball.angle, LE); o+=4;
    dv.setInt16(o, s1|0, LE); o+=2;
    dv.setInt16(o, s2|0, LE); o+=2;
    dv.setInt16(o, rh|0, LE); o+=2;
    // ss всегда +1/-1 — один бит. w/lh — 0/1/2 в двух nibble.
    const flags = (p1.onGround?1:0) | (p2.onGround?2:0) | (mo?4:0) | (ro?8:0) | (ss > 0 ? 16:0);
    dv.setUint8(67, flags);
    const wCode  = (w === 1) ? 1 : (w === 2 ? 2 : 0);
    const lhCode = (lh === 1) ? 1 : (lh === 2 ? 2 : 0);
    dv.setUint8(68, (lhCode & 0x0F) | ((wCode & 0x0F) << 4));
    return _stateU8;
  }

  function encodeEmote(id){
    const n = parseInt(id, 10) | 0;
    if (n < 1 || n > 255) return null;
    const u = new Uint8Array(2);
    u[0] = 0x03;
    u[1] = n;
    return u;
  }

  // decode принимает ArrayBuffer (WebSocket binaryType="arraybuffer" у
  // клиента) ИЛИ Buffer (server-side ws-пакет). Внутри приводим к ArrayBuffer-
  // view через byteOffset/byteLength, чтобы DataView видел правильную память.
  function decode(buf){
    let u, dv;
    if (typeof Buffer !== "undefined" && buf instanceof Buffer){
      u = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    } else if (buf instanceof ArrayBuffer){
      u = new Uint8Array(buf);
      dv = new DataView(buf);
    } else if (ArrayBuffer.isView(buf)){
      u = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    } else {
      return null;
    }
    if (u.length < 1) return null;
    const op = u[0];
    if (op === 0x01 && u.length >= 2){
      const f = u[1];
      return { kind:"input", left:!!(f&1), right:!!(f&2), jump:!!(f&4) };
    }
    if (op === 0x02 && u.length >= STATE_FRAME_BYTES){
      const seq       = dv.getUint32(1, LE);
      const srvTickMs = dv.getUint32(5, LE);
      let o = 9;
      const p1 = { x:dv.getFloat32(o,LE), y:dv.getFloat32(o+4,LE), vx:dv.getFloat32(o+8,LE), vy:dv.getFloat32(o+12,LE) }; o+=16;
      const p2 = { x:dv.getFloat32(o,LE), y:dv.getFloat32(o+4,LE), vx:dv.getFloat32(o+8,LE), vy:dv.getFloat32(o+12,LE) }; o+=16;
      const b  = { x:dv.getFloat32(o,LE), y:dv.getFloat32(o+4,LE), vx:dv.getFloat32(o+8,LE), vy:dv.getFloat32(o+12,LE), a:dv.getFloat32(o+16,LE) }; o+=20;
      const s1 = dv.getInt16(o, LE); o+=2;
      const s2 = dv.getInt16(o, LE); o+=2;
      const rh = dv.getInt16(o, LE); o+=2;
      const f  = dv.getUint8(67);
      const lhw = dv.getUint8(68);
      p1.g = (f & 1) ? 1 : 0;
      p2.g = (f & 2) ? 1 : 0;
      const mo = (f & 4) ? 1 : 0;
      const ro = (f & 8) ? 1 : 0;
      const ss = (f & 16) ? 1 : -1;
      const wCode  = (lhw >> 4) & 0x0F;
      const lhCode = lhw & 0x0F;
      const w  = wCode === 0 ? null : wCode;
      const lh = lhCode;
      return { kind:"state", seq, srvTickMs, p1, p2, b, s1, s2, rh, mo, ro, ss, w, lh };
    }
    if (op === 0x03 && u.length >= 2){
      return { kind:"emote", id: String(u[1]).padStart(2, "0") };
    }
    return null;
  }
  const CODEC = Object.freeze({ encodeInput, encodeState, encodeEmote, decode, STATE_FRAME_BYTES });
  if(typeof module !== "undefined" && module.exports){
    module.exports = CODEC;
  }
  if(root) root.DVCodec = CODEC;
})(typeof window !== "undefined"
     ? window
     : (typeof globalThis !== "undefined" ? globalThis : null));
