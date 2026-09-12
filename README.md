# dsh-token-speed

把 DSH Web GUI 状态栏里那个「… 词元/秒」**就地换成实时速度**。

官方那个数字是**每个 turn 结束后**算出来的平均值，看不到"此刻正以多快生成"。
本插件用逐 chunk 的实测速度替换它：生成中实时跳动，停下来保留最后的值
（不会变空），从没生成过就保持官方原值不动。

## 它怎么工作

```
llm/stream waterfall ──包装──▶ 下游 chunk 流（原样透传，不改变模型可见内容）
                           └─▶ 采样 (时间, 累计token) ─▶ 3 秒滑动窗口
                                                        └─▶ GET /dsh-tokspeed/api/speed
                                                              └─▶ 浏览器半边轮询并显示
```

- **host 半边**（`lib/index.js`）：挂在 `llm/stream` waterfall 上包装下游流，逐个
  chunk 记录时间与累计 token，维护 3 秒滑动窗口算出瞬时速度，再用 `webServer.register`
  暴露一个小 JSON。
- **浏览器半边**（`lib/client.js`）：每 250ms 轮询该 JSON，**直接改写**官方那个速度
  节点的文本（单位沿用原文，所以中英文界面都对）。首次改写前把原文存进
  `data-dsh-tokspeed-orig`，插件卸载时还原——我们只是借用这个位置，不破坏官方内容。

> **改动注意（三个已踩的坑）**
> - **定位不能用"只看叶子节点"**：官方把「235 词元/秒」拆在多层 span 里，叶子判断
>   会整批跳过。现在按文档顺序取**最内层**的匹配元素。
> - **写入会被 React 覆盖**，所以用 `MutationObserver` + 轮询持续维持；写入前对比
>   上次文本，避免无意义的 DOM 抖动（否则 observer 会被自己触发成死循环）。
> - **所有 DOM 操作都包了兜底**：apply 抛错会让 GUI 弹「Failed to load plugins」
>   并中断整个插件，宁可这个特性不显示也不能炸界面。

## 显示约定

| 状态 | 显示 |
|---|---|
| 正在生成 | 实时值，如 `88.2 词元/秒` |
| 生成结束 | **保留最后那个值**（不清空） |
| 从未生成过 | 保持官方原值不动 |

单位取自官方原文，所以中文界面显示「词元/秒」、英文界面显示「tok/s」。

## 关于 token 数是估算

逐 token 的精确用量要等一次 step 结束、provider 回报 usage 才有——那样就不叫"实时"了。
所以实时阶段用启发式估算：**CJK 约 1 字/token，ASCII 约 4 字符/token**。
中文场景下这个估算和真实值的偏差通常在可接受范围内；turn 结束后官方那个
「词元/秒」仍是精确值，两者可以互相参照。

## 安装

```sh
dsh plugin --profile web add link:/Users/rkd/dsh/dsh-token-speed
```

然后重启 web 服务（host 半边在启动时挂载；浏览器半边随页面加载）。

## 卸载

```sh
dsh plugin --profile web remove dsh-token-speed
```
