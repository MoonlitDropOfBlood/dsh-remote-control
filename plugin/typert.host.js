/**
 * dsh-remote-control — Typert Host manifest.
 *
 * Hand-written TYPERT manifest (the format the DSH typert-loader consumes from
 * the package's `./typert` export). It describes the `remoteControl` Remote
 * service the Host half publishes so the browser Client half can call it
 * through `ctx.remote.remoteControl.*` (设置面板「DSH Pocket」分区).
 *
 * Keep the invocation ids, service/namespace names and method names in sync
 * with `index.js` (RemoteControlService) and `client.js`.
 */

import { z } from "zod";

// typert-loader's strict codec path rejects codecs without a create() factory
// (a v1.5.0 manifest shipped without them and the loader never registered it,
// so every Remote call failed). Every codec below is paired with its factory;
// run `node scripts/verify-settings.mjs` after changes.
const createStringSchema = () => z.string();
const createBooleanSchema = () => z.boolean();

// ---- shared shapes ---------------------------------------------------------

/** 设置面板需要的配对信息（**不含 secret 明文**：secret 只存在于二维码图像里）。 */
const pairingValueSchema = z
  .object({
    relayUrl: z.string(),
    channel: z.string(),
    hidden: z.boolean(),
    qrSvg: z.string(),
    note: z.string(),
  })
  .readonly();

/** 统一的 Remote 结果信封：{ok:true,value} | {ok:false,error}。 */
const pairingResultSchema = z.union([
  z
    .object({
      ok: z.literal(true).readonly(),
      value: pairingValueSchema,
    })
    .readonly(),
  z
    .object({
      ok: z.literal(false).readonly(),
      error: z
        .object({
          code: z.string().readonly(),
          message: z.string().readonly().optional(),
        })
        .readonly(),
    })
    .readonly(),
]);

const createPairingResult = () => pairingResultSchema;

/** Android 版 APK 下载信息（直链 + 二维码；与中继配置/配对状态无关）。 */
const androidDownloadValueSchema = z
  .object({
    version: z.string(),
    fileName: z.string(),
    url: z.string(),
    releasesUrl: z.string(),
    qrSvg: z.string(),
    note: z.string(),
  })
  .readonly();

/** getAndroidDownload 的结果信封：{ok:true,value} | {ok:false,error}。 */
const androidDownloadResultSchema = z.union([
  z
    .object({
      ok: z.literal(true).readonly(),
      value: androidDownloadValueSchema,
    })
    .readonly(),
  z
    .object({
      ok: z.literal(false).readonly(),
      error: z
        .object({
          code: z.string().readonly(),
          message: z.string().readonly().optional(),
        })
        .readonly(),
    })
    .readonly(),
]);

const createAndroidDownloadResult = () => androidDownloadResultSchema;

export const TYPERT = {
  package: "@duke-dsh-plugins/dsh-remote-control",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-remote-control#remoteControl/getPairing",
      service: "remoteControl",
      namespace: "remoteControl",
      method: "getPairing",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-remote-control#PairingResult",
        schema: pairingResultSchema,
        create: createPairingResult,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-remote-control#remoteControl/rotateSecret",
      service: "remoteControl",
      namespace: "remoteControl",
      method: "rotateSecret",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-remote-control#PairingResult",
        schema: pairingResultSchema,
        create: createPairingResult,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-remote-control#remoteControl/setHidden",
      service: "remoteControl",
      namespace: "remoteControl",
      method: "setHidden",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "hidden",
          wire: "hidden",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-remote-control#remoteControl/setHidden:hidden",
            schema: z.boolean(),
            create: createBooleanSchema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-remote-control#PairingResult",
        schema: pairingResultSchema,
        create: createPairingResult,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-remote-control#remoteControl/setRelayUrl",
      service: "remoteControl",
      namespace: "remoteControl",
      method: "setRelayUrl",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "url",
          wire: "url",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-remote-control#remoteControl/setRelayUrl:url",
            schema: z.string(),
            create: createStringSchema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-remote-control#PairingResult",
        schema: pairingResultSchema,
        create: createPairingResult,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      // v1.1.3：中继门口的鉴权令牌（对应中继的 RELAY_TOKEN）。
      // 令牌会出现在 transport hello 里（明文可读），所以设置页不回显明文，
      // 只回 relayTokenSet；配对二维码会带上它（契约 §3.5 的 t= 参数）。
      id: "dsh-remote-control#remoteControl/setRelayToken",
      service: "remoteControl",
      namespace: "remoteControl",
      method: "setRelayToken",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "token",
          wire: "token",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-remote-control#remoteControl/setRelayToken:token",
            schema: z.string(),
            create: createStringSchema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-remote-control#PairingResult",
        schema: pairingResultSchema,
        create: createPairingResult,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      // Android 版安装包下载地址 + 二维码（设置面板渲染用）。
      // 与中继配置、配对隐藏状态无关——首次安装也能下载。
      id: "dsh-remote-control#remoteControl/getAndroidDownload",
      service: "remoteControl",
      namespace: "remoteControl",
      method: "getAndroidDownload",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-remote-control#AndroidDownloadResult",
        schema: androidDownloadResultSchema,
        create: createAndroidDownloadResult,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
  ],
  model: {
    services: [
      {
        description:
          "Remote-control pairing service: exposes the relay address, the pairing channel and the pairing QR code to the desktop settings panel, plus relay-address editing, key rotation, pairing hide/show and the Android APK download link with its QR code.",
        summary: "Remote-control pairing service for the settings panel.",
        tags: [],
        jsDoc:
          "/**\n * Remote-control pairing service: publishes the pairing QR code, the relay\n * address editor and the rotate / hide operations to the desktop settings panel.\n */",
        key: "remoteControl",
        exportName: "RemoteControlService",
        members: [
          {
            kind: "method",
            name: "getPairing",
            signature: "@Remote('getPairing') async getPairing(): Promise<PairingResult>",
            summary:
              "Return the current pairing information: relay URL, channel, hidden flag and the pairing QR code (SVG).",
            jsDoc:
              "/**\n * Return the current pairing information for the settings panel.\n * The secret is only carried inside the QR image — never as plain text.\n * @returns success with the pairing payload or a business failure.\n */",
          },
          {
            kind: "method",
            name: "rotateSecret",
            signature: "@Remote('rotateSecret') async rotateSecret(): Promise<PairingResult>",
            summary:
              "Rotate the pairing identity (channel + secret); the previous QR code stops working immediately.",
            jsDoc:
              "/**\n * Rotate the pairing identity: a new channel/secret is generated, persisted\n * and pushed to the relay link, so the old QR code stops working at once.\n * @returns success with the fresh pairing payload or a business failure.\n */",
          },
          {
            kind: "method",
            name: "setHidden",
            signature: "@Remote('setHidden') async setHidden(hidden: boolean): Promise<PairingResult>",
            summary: "Hide or re-show the pairing QR code in the settings panel.",
            jsDoc:
              "/**\n * Hide (or re-show) the pairing QR code in the settings panel and drop the\n * on-disk pairing.svg accordingly.\n * @param hidden - true hides the pairing, false shows it again.\n * @returns success with the resulting pairing payload or a business failure.\n */",
          },
          {
            kind: "method",
            name: "setRelayUrl",
            signature: "@Remote('setRelayUrl') async setRelayUrl(url: string): Promise<PairingResult>",
            summary:
              "Set the relay address from the settings panel: validate, persist and hot-switch the relay link; an empty string clears it.",
            jsDoc:
              "/**\n * Set the relay address: the value is validated (ws:// or wss:// with a host,\n * at most 512 characters), persisted to config.json and pushed into the relay\n * link, which reconnects to the new address at once. An empty string clears\n * the address and idles the plugin.\n * @param url - the relay address, or an empty string to clear it.\n * @returns success with the fresh pairing payload or a business failure.\n */",
          },
          {
            kind: "method",
            name: "getAndroidDownload",
            signature: "@Remote('getAndroidDownload') async getAndroidDownload(): Promise<AndroidDownloadResult>",
            summary:
              "Return the Android APK download info: a version-pinned asset direct link plus a QR code for it; independent of the relay configuration.",
            jsDoc:
              "/**\n * Return the Android APK download info for the settings panel: the\n * version-pinned release asset URL and a QR code pointing at it.\n * Does not depend on the relay address or the pairing hidden flag, so the\n * APK can be downloaded before the phone is paired.\n * @returns success with the download payload or a business failure.\n */",
          },
        ],
        types: [
          {
            name: "PairingValue",
            declaration:
              "export interface PairingValue {\n    readonly relayUrl: string;\n    readonly channel: string;\n    readonly hidden: boolean;\n    readonly qrSvg: string;\n    readonly note: string;\n}",
          },
          {
            name: "PairingResult",
            declaration:
              "export type PairingResult = { ok: true; value: PairingValue } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "AndroidDownloadValue",
            declaration:
              "export interface AndroidDownloadValue {\n    readonly version: string;\n    readonly fileName: string;\n    readonly url: string;\n    readonly releasesUrl: string;\n    readonly qrSvg: string;\n    readonly note: string;\n}",
          },
          {
            name: "AndroidDownloadResult",
            declaration:
              "export type AndroidDownloadResult = { ok: true; value: AndroidDownloadValue } | { ok: false; error: { code: string; message?: string } };",
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
};
