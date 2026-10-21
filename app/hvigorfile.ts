// @ts-nocheck – Template file, only used when copied into a project directory
import { appTasks } from '@ohos/hvigor-ohos-plugin';
import { hrouterPlugin } from 'hrouter-compiler';

// hvigor 26（modelVersion 26.0.0）的插件节点不再暴露 getRootProject / getProjectModel，
// 而 hrouter-compiler 2.0.0 用它们判定「是否项目根节点」——判定不成功就完全不扫描。
// 这里做一层零侵入兼容：apply 时给节点补一个 getRootProject（只影响该插件的判定，
// 不改变 hvigor 行为；不 fork 插件源码）。
const hrouter = hrouterPlugin({
  // entry 是唯一生成 service_map.json 的 root 模块；本工程无 library 子模块。
  root: 'entry',
  // 只扫描页面目录（@Route 页面）。model/ 下无路由/服务/拦截器装饰器，无需扫描。
  scanPaths: ['src/main/ets/pages']
});

const hrouterCompat = {
  pluginId: 'hrouterCompat',
  apply(node: any) {
    if (typeof node.getRootProject !== 'function' && typeof node.getProjectModel !== 'function') {
      try {
        node.getRootProject = function () {
          return node;
        };
      } catch (e) {
        console.warn('[hrouter-compat] cannot patch node: ' + e);
      }
    }
    hrouter.apply(node);
  }
};

export default {
  system: appTasks /* Built-in plugin of Hvigor. It cannot be modified. */,
  plugins: [hrouterCompat] /* Custom plugin to extend the functionality of Hvigor. */,
};
