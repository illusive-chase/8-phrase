# 八句话

录好 8 句话，见面时两人一人一只耳机，一整天只靠点按钮播放这 8 句话交流。谁先开口说了别的话，谁请吃饭。

网址：<https://illusive-chase.github.io/8-phrase/>

- 手机竖屏一屏放下 8 个大按钮，点一下就播放对应的录音。
- 句子和录音**只存在你自己的手机上**，代码里没有任何句子；朋友打开同一个网址，录的是他自己的 8 句。
- 支持离线打开、添加到主屏幕、播放次数统计、屏幕常亮。

## 怎么用

1. **iPhone 先添加到主屏幕**（见下一节），安卓建议也安装一下。
2. 打开后点右上角 ✎ 进入编辑模式，点任意一张卡片：
   - 在输入框里写这句话的文字（显示在按钮上，最多 30 个字）；
   - **按住**红色按钮说话，松手保存；按住时往上滑再松手就是取消；最长 15 秒；
   - 用 `‹` `›` 切换上一句 / 下一句，一口气录完 8 句。
3. 点「完成」回到播放模式。当天戴上耳机，点按钮就行。

小提示：

- 建议在安静的地方、不戴耳机、用手机自带的麦克风录音。开头和结尾的静音会自动裁掉，音量会自动调到差不多大。
- 播放时再点同一张卡片会从头重播，点另一张会立刻切换。
- 屏幕常亮开关（☀）默认打开；揣进口袋前按一下电源键锁屏即可。
- 两只耳机都能听到完整的声音（录音存成单声道）。
- 蓝牙耳机本身有 0.1～0.3 秒的延迟，网页没法消除。

## iPhone：先「添加到主屏幕」，再录音

在 iPhone 上，**Safari 标签页**和**主屏幕上的应用**各存各的数据：在 Safari 标签页里录好的音频，从主屏幕图标打开是看不到的；Safari 标签页里的数据 7 天不访问还可能被系统清除。所以请按这个顺序：

1. 用 Safari 打开网址 → 点「分享」→「添加到主屏幕」。
2. **从主屏幕图标打开**，在里面录完 8 句话。
3. 当天也从主屏幕图标打开来玩（全屏、没有地址栏、断网也能用）。

iPhone 从主屏幕打开时，每次启动可能都会重新问一次麦克风权限，这是系统行为。

如果打开了静音开关后听不到声音，请关掉静音开关（较新的 iOS 支持静音开关下照常播放，旧版本不支持）。

## 数据存在哪里、什么时候会丢

- 文字、录音和播放次数存在浏览器的 IndexedDB 里，只在这台手机上，不会上传到任何地方。
- 只有三种情况会丢失：在编辑模式里点「清除」、手动清除浏览器的网站数据、在 iPhone 上删除主屏幕图标。
- 更新网站不会影响已经录好的内容。

## 开发

纯静态网站：原生 HTML / CSS / JavaScript（ES Modules），没有框架、没有构建步骤、没有第三方依赖。

```
index.html               页面骨架
styles.css               样式
js/app.js                入口：状态、渲染、事件
js/db.js                 IndexedDB 封装
js/player.js             播放引擎（Web Audio）
js/recorder.js           麦克风、按住说话的手势
js/recorder-worklet.js   AudioWorklet：预录缓冲、采集、音量
js/process.js            录音处理：静音裁剪 → 淡入淡出 → 归一化 → WAV（纯函数）
js/fit-text.js           卡片文字字号自适应
js/wakelock.js           屏幕常亮
sw.js                    Service Worker（离线缓存）
manifest.webmanifest     PWA 配置
icons/                   图标（icon.svg 是源文件，PNG 由它导出并提交进仓库）
tests/process.test.mjs   录音处理的单元测试
```

本地运行（localhost 被浏览器视为安全连接，可以录音）：

```sh
python3 -m http.server 8731
# 打开 http://localhost:8731/
```

运行测试（只用 Node 自带的 `node:test`）：

```sh
node --test tests/*.test.mjs
```

静音裁剪的参数（底噪 +12 dB、不低于 -50 dBFS、连续 30ms 算人声、前后余量 40ms / 120ms 等）集中放在 `js/process.js` 顶部，真机试用后如果句首被吃掉或空白太长，就调这里。

修改图标后重新导出 PNG：

```sh
rsvg-convert -w 512 -h 512 icons/icon.svg -o icons/icon-512.png
rsvg-convert -w 192 -h 192 icons/icon.svg -o icons/icon-192.png
rsvg-convert -w 180 -h 180 icons/icon.svg -o icons/apple-touch-icon.png
```

## 发布新版本

1. **把 `sw.js` 顶部的 `VERSION` 加 1**（否则已经打开过的手机会一直用旧版本）。如果新增了文件，同时加进 `sw.js` 的 `ASSETS` 列表。
2. 推送到 `main` 分支，GitHub Pages 会自动部署。
3. 手机上完全关掉应用再打开一次（有时需要两次）即可拿到新版本。

首次部署：仓库需要是公开的（免费账号的要求），然后在 **Settings → Pages → Deploy from a branch** 选择 `main` / `(root)`。仓库根目录的 `.nojekyll` 用来跳过 Jekyll 处理。所有资源都用相对路径，因为站点部署在 `/8-phrase/` 子路径下。
