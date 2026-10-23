/** 公共类型与常量 */

export interface WbiKeys {
  img: string;
  sub: string;
}

export interface Config {
  delayMin: number;
  delayMax: number;
  batchSize: number;
  restMin: number;
  restMax: number;
  maxRetries: number;
  dailyLimit: number;
  dryRun: boolean;
  skipPinned: boolean;
  keepFollowing: string;
  cooldownMinutes: number;
}

export interface DynamicItem {
  id: string;
  type: string;
  pinned: boolean;
  desc: string;
}

export interface FollowingItem {
  mid: number;
  uname: string;
}

export interface CommentTarget {
  type: number;
  oid: number;
  /** 根评论 id，用它可一次性拿到整楼评论 */
  rootId?: number;
  title?: string;
  ts?: number;
}

export interface OwnComment {
  rpid: string;
  content: string;
  type: number;
  oid: number;
}

export interface BiliResponse<T = unknown> {
  code: number;
  message: string;
  ttl?: number;
  data: T;
}

export type TaskKind = 'dyn' | 'flw' | 'cmt';
export type RunnerState = 'idle' | 'running' | 'paused' | 'stopping';

/** 用户主动停止任务 */
export class StopError extends Error {
  constructor() {
    super('任务已停止');
    this.name = 'StopError';
  }
}

/** B站接口业务异常 */
export class BiliError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
  }
}

export const API = {
  NAV: 'https://api.bilibili.com/x/web-interface/nav',
  DYNAMIC_FEED: 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space',
  DYNAMIC_DEL: 'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic',
  FOLLOWINGS: 'https://api.bilibili.com/x/relation/followings',
  RELATION_MODIFY: 'https://api.bilibili.com/x/relation/modify',
  REPLY_MAIN: 'https://api.bilibili.com/x/v2/reply/wbi/main',
  REPLY_REPLY: 'https://api.bilibili.com/x/v2/reply/reply',
  REPLY_DEL: 'https://api.bilibili.com/x/v2/reply/del',
  MSGFEED_REPLY: 'https://api.bilibili.com/x/msgfeed/reply'
} as const;

export const DYNAMIC_DELETABLE: Record<string, boolean> = {
  DYNAMIC_TYPE_DRAW: true,
  DYNAMIC_TYPE_WORD: true,
  DYNAMIC_TYPE_FORWARD: true,
  DYNAMIC_TYPE_AV: true,
  DYNAMIC_TYPE_ARTICLE: true
};

export const COMMENT_TYPE_MAP: Record<string, number> = {
  video: 1,
  article: 12,
  dynamic: 17,
  album: 11,
  audio: 14,
  live: 15
};
