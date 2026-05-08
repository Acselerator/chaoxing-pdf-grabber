# 图标准备说明

这里用于放置公开发布用的脚本图标。

建议生成一张高分辨率源图，再导出下面两个 PNG 文件：

- `icon-32.png`：32 x 32，用于低分辨率脚本图标。
- `icon-64.png`：64 x 64，用于 Tampermonkey 管理页等高分辨率位置。

可选保留：

- `icon-source.png`：1024 x 1024 或 512 x 512 的源图。
- `icon-source.svg`：如果使用矢量源文件。

设计建议：

- 正方形画布。
- PNG 格式，透明背景或纯色背景均可。
- 图形在 32 x 32 下仍能辨认。
- 避免小字、复杂纹理和过细线条。
- 主体可以围绕“学习通/课程/PDF/下载/文档”这些概念，但不要直接使用超星或学习通的官方商标图形。

图标加入仓库后，脚本头部可增加：

```js
// @icon        https://raw.githubusercontent.com/Acselerator/chaoxing-pdf-grabber/main/assets/icons/icon-32.png
// @icon64      https://raw.githubusercontent.com/Acselerator/chaoxing-pdf-grabber/main/assets/icons/icon-64.png
```

新增或修改脚本元信息后，需要提升 `@version` 并同步更新 Greasy Fork。
