// lib/downloads.mjs —— Android 版安装包的下载信息 + 二维码（设置面板用）。
//
// 职责：把「当前插件版本」换算成 Android APK 的下载地址，并给这个地址生成
// 一张二维码 SVG（手机扫码直接下载/打开）。
//
// 为什么**版本钉扎**而不是 releases/latest：
//   资产文件名里带版本号（dsh-pocket-android-<version>.apk），latest 指向的
//   Release 一旦升级版本，这个直链就会 404。所以地址里写死 v<version>。
//
// 运行时零依赖：只用 node 内置 + ./qr.mjs（不读 package.json——版本号由
// lib/host-bridge.mjs 的 pluginVersion() 提供，那是版本号的唯一出处）。
import { encodeToMatrix, toSvg } from "./qr.mjs";

/** GitHub 仓库 slug（owner/repo）——Android 版 APK 发布在这里。 */
export const RELEASES_REPO = "MoonlitDropOfBlood/dsh-remote-control";

/** APK 资产文件名前缀（后面跟 `-<version>.apk`）。 */
export const APK_FILE_PREFIX = "dsh-pocket-android";

/** 合法版本号（严格三段数字；其它一律按「未知版本」处理）。 */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * 构造 Android 版下载信息（纯函数，不抛错）。
 *
 * - 版本合法 → url = 版本钉扎的 release 资产直链，fileName = 资产名；
 * - 版本未知/非法 → url = Release 页（人可点），fileName = ""，note 说明原因；
 * - 二维码生成失败 → qrSvg = ""，note 追加提示（**绝不抛错**）。
 *
 * @param {string} version 插件版本号（如 "1.3.6"）
 * @param {{repo?:string}} [options] repo 可覆盖仓库 slug（测试/分支用）
 * @returns {{version:string, fileName:string, url:string, releasesUrl:string, qrSvg:string, note:string}}
 */
export function buildAndroidDownload(version, options = {}) {
  const repo =
    typeof options?.repo === "string" && options.repo.trim() !== ""
      ? options.repo.trim()
      : RELEASES_REPO;
  const releasesUrl = "https://github.com/" + repo + "/releases";

  const raw = typeof version === "string" ? version.trim() : "";
  const known = VERSION_RE.test(raw);
  const ver = known ? raw : "unknown";
  const fileName = known ? APK_FILE_PREFIX + "-" + ver + ".apk" : "";
  // 版本钉扎：资产名带版本，用 releases/latest 会在下一版 404。
  const url = known ? releasesUrl + "/download/v" + ver + "/" + fileName : releasesUrl;

  let qrSvg = "";
  let note = "";
  try {
    qrSvg = toSvg(encodeToMatrix(url), { scale: 6, quiet: 4 });
  } catch {
    qrSvg = "";
    note = "二维码生成失败，请直接复制下方下载地址。";
  }
  if (!known) {
    note =
      (note ? note + " " : "") +
      "无法确定当前插件版本，请到 Releases 页面下载对应版本的 APK。";
  }
  return { version: ver, fileName, url, releasesUrl, qrSvg, note };
}
