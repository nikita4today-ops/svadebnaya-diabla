/**
 * net.ts — P2P-мультиплеер «Свадебной Диаблы» через trystero.
 * Сигналинг — публичные nostr-релеи (wss), дальше прямое WebRTC между игроками.
 * Сервер не нужен: создатель лобби становится хостом и считает симуляцию.
 */

import { joinRoom } from "trystero";
import type { Room } from "trystero";

const APP_ID = "svadebnaya-diabla-v1";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function makeRoomCode(): string {
  let s = "";
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

export interface LobbyPlayer { pid: string; hero: string; host: boolean }
export interface LobbyMsg { pl: LobbyPlayer[] }
export interface StartMsg { pl: LobbyPlayer[] }
export interface HeroMsg { hero: string }
export interface InpMsg { x: number; y: number; fx: number; wk: number; mv: boolean }
export interface CastMsg { k: string; dir: number }

/** Игрок в снапшоте (компактные ключи — снапшоты идут 10 раз в секунду). */
export interface SnapPlayer {
  h: string; x: number; y: number; fx: number; wk: number; mv: boolean;
  hp: number; mh: number; mn: number; lv: number; dm: number;
  sw: number; sh: number; da: number; al: boolean;
  /** Маунт, ярость, кручение — для визуала и скорости на клиенте. */
  mo: number; rg: number; spn: number;
  cb: number; cq: number; ce: number; cr: number; ct: number; cf: number;
}
export interface SnapEnemy { i: number; k: number; s: number; x: number; y: number; hp: number; mhp: number; b: boolean; w: boolean; c: boolean }
export interface SnapProj { i: number; k: string; x: number; y: number; vx: number; vy: number; r: number; c: string; f: boolean }
export interface SnapSatoru { p: string; x: number; y: number; l: number }
export interface SnapClone { x: number; y: number; wk: number }
export interface SnapDragon { x: number; y: number; ang: number }
export interface SnapMsg {
  t: number; wave: number; kills: number;
  pl: Record<string, SnapPlayer>;
  en: SnapEnemy[]; pr: SnapProj[]; orb: number[][]; sat: SnapSatoru[];
  cl: SnapClone[]; dr: SnapDragon[];
}

export type EvMsg =
  | { t: "ann"; x: string; s: string }
  | { t: "castfx"; h: string; k: string; x: number; y: number; dir: number }
  | { t: "boom"; x: number; y: number }
  | { t: "over"; time: number; kills: number; wave: number };

type Handler<T> = (data: T, peerId: string) => void;

/** Обёртка над комнатой trystero с типизированными каналами. */
export class Net {
  readonly code: string;
  private room: Room;
  private lobbyH: Handler<LobbyMsg>[] = [];
  private startH: Handler<StartMsg>[] = [];
  private heroH: Handler<HeroMsg>[] = [];
  private inpH: Handler<InpMsg>[] = [];
  private castH: Handler<CastMsg>[] = [];
  private snapH: Handler<SnapMsg>[] = [];
  private evH: Handler<EvMsg>[] = [];
  private joinH: ((pid: string) => void)[] = [];
  private leaveH: ((pid: string) => void)[] = [];

  constructor(code: string) {
    this.code = code;
    this.room = joinRoom({ appId: APP_ID }, code);
    const wire = <T,>(name: string, hs: Handler<T>[]) => {
      const a = this.room.makeAction(name) as unknown as {
        send: (d: T, o?: { target?: string }) => Promise<void>;
        onMessage: (h: (d: T, ctx: { peerId: string }) => void) => unknown;
      };
      a.onMessage((data, ctx) => { for (const h of hs) h(data, ctx.peerId); });
      return a;
    };
    const lobby = wire<LobbyMsg>("lobby", this.lobbyH);
    const start = wire<StartMsg>("start", this.startH);
    const hero = wire<HeroMsg>("hero", this.heroH);
    const inp = wire<InpMsg>("inp", this.inpH);
    const cast = wire<CastMsg>("cast", this.castH);
    const snap = wire<SnapMsg>("snap", this.snapH);
    const ev = wire<EvMsg>("ev", this.evH);
    this.sendLobby = (d) => { lobby.send(d).catch(() => {}); };
    this.sendStart = (d) => { start.send(d).catch(() => {}); };
    this.sendHero = (d) => { hero.send(d).catch(() => {}); };
    this.sendInp = (d, to) => { inp.send(d, { target: to }).catch(() => {}); };
    this.sendCast = (d, to) => { cast.send(d, { target: to }).catch(() => {}); };
    this.sendSnap = (d) => { snap.send(d).catch(() => {}); };
    this.sendEv = (d) => { ev.send(d).catch(() => {}); };

    this.room.onPeerJoin((ctx) => { for (const h of this.joinH) h(ctx.peerId); });
    this.room.onPeerLeave((ctx) => { for (const h of this.leaveH) h(ctx.peerId); });
  }

  sendLobby: (d: LobbyMsg) => void;
  sendStart: (d: StartMsg) => void;
  sendHero: (d: HeroMsg) => void;
  sendInp: (d: InpMsg, to: string) => void;
  sendCast: (d: CastMsg, to: string) => void;
  sendSnap: (d: SnapMsg) => void;
  sendEv: (d: EvMsg) => void;

  onLobby(h: Handler<LobbyMsg>): void { this.lobbyH.push(h); }
  onStart(h: Handler<StartMsg>): void { this.startH.push(h); }
  onHero(h: Handler<HeroMsg>): void { this.heroH.push(h); }
  onInp(h: Handler<InpMsg>): void { this.inpH.push(h); }
  onCast(h: Handler<CastMsg>): void { this.castH.push(h); }
  onSnap(h: Handler<SnapMsg>): void { this.snapH.push(h); }
  onEv(h: Handler<EvMsg>): void { this.evH.push(h); }
  onPeerJoin(h: (pid: string) => void): void { this.joinH.push(h); }
  onPeerLeave(h: (pid: string) => void): void { this.leaveH.push(h); }

  peerCount(): number { return Object.keys(this.room.getPeers()).length; }

  async leave(): Promise<void> {
    try { await this.room.leave(); } catch { /* уже отключены */ }
  }
}
