/**
 * dsh-token-speed — token 速度实时显示
 *
 * 把状态栏里官方那个「235 词元/秒」**直接替换**成实时速度：
 *   - 生成中：每 250ms 刷新成本轮实时值
 *   - 生成结束：保留最后一次的值（不清空、不显示占位符）
 *   - 从未生成过：保持官方原值不动
 *
 * 实现要点（都是踩过的坑）：
 *   1. 官方把数字与单位包在多层 span 里，定位必须用"文档顺序取最内层匹配"，
 *      只看叶子节点会漏掉（官方结构会变）。
 *   2. 直接改文本会被 React 重渲染覆盖，所以用 MutationObserver + 轮询持续维持；
 *      写入前对比上次文本，避免无意义的 DOM 抖动。
 *   3. 首次改写前把原文存进 data-dsh-tokspeed-orig，插件卸载时还原——
 *      我们只是"借用"这个位置显示实时值，不破坏官方内容。
 *   4. 任何 DOM 异常都必须吞掉：apply 抛错会让 GUI 弹「Failed to load plugins」。
 */
window.__ModuleLoader__.load({
    id: 'dsh-token-speed',
    factory: function (require) {
        var module = { exports: {} };
        var exports = module.exports;

        var API = '/dsh-tokspeed/api/speed';
        var POLL_MS = 250;
        var ATTR = 'data-dsh-tokspeed';
        var ORIG_ATTR = ATTR + '-orig';
        /** 官方速度文案（中文/英文界面都要能认出来）。 */
        var STATS_RE = /词元\s*\/\s*秒|tok\s*\/\s*s|tokens?\s*\/\s*s(ec)?/i;
        /** 去掉开头的数字部分，剩下的就是单位（"词元/秒" / "tok/s"）。 */
        var LEADING_NUM_RE = /^[\s\d.,:：+\-—]*/;

        var target = null;      // 官方速度节点
        var lastTps = null;     // 最近一次有效速度；空闲时沿用它
        var lastText = '';      // 上次写入的文本，避免重复写 DOM
        var pollTimer = null;
        var observer = null;
        var locateTimer = null;

        /** 找统计文案所在的**最内层**元素（文档顺序，最后一个命中的最深）。 */
        function findSpeedNode() {
            var all = document.querySelectorAll('*');
            var best = null;
            for (var i = 0; i < all.length; i++) {
                var el = all[i];
                var tag = el.tagName;
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
                var text = el.textContent;
                if (typeof text !== 'string' || text.length === 0 || text.length > 160) continue;
                if (STATS_RE.test(text)) best = el;
            }
            return best;
        }

        /**
         * 官方原文里「数字 + 单位」那一段。
         * 只把数字换掉：单位（词元/秒、tok/s）以及原文里的其他内容——比如
         * 「29 轮 311 步」——一个字都不动。
         */
        var SPEED_PART_RE = /(\d[\d.,]*)(\s*(?:词元\s*\/\s*秒|tok\s*\/\s*s|tokens?\s*\/\s*s(ec)?))/i;

        /** 第一次处理这个节点时，把官方原文整个记下来（后续都基于它做替换）。 */
        function rememberOrigin(node) {
            if (node.getAttribute(ORIG_ATTR) === null) {
                node.setAttribute(ORIG_ATTR, node.textContent || '');
            }
        }

        /**
         * 中文排版惯例：中点两侧各留一个空格。
         * 原文没有就补上，已经有了也不会叠成两个（同一段文本重复处理是幂等的）。
         */
        function normalizeDots(text) {
            return text.replace(/\s*·\s*/g, ' · ');
        }

        function speedText(orig, tps) {
            var value = tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1);
            if (SPEED_PART_RE.test(orig)) {
                return normalizeDots(orig.replace(SPEED_PART_RE, value + '$2'));
            }
            // 极少数情况原文里没有可替换的数字，退化为追加
            return normalizeDots(orig + ' · ' + value + ' tok/s');
        }

        /**
         * 把实时值写进官方节点。
         * 关键：每次都基于**官方原文**做替换，而不是基于当前文本——后者会把自己的
         * 上一次结果当成原文，数字越滚越长。tps 为空（从未生成过）时显示官方原文。
         */
        function paint(tps) {
            if (target === null || !target.isConnected) return;
            rememberOrigin(target);
            var orig = target.getAttribute(ORIG_ATTR);
            if (orig === null) return;
            var text = (tps === null || tps === undefined)
                ? normalizeDots(orig)
                : speedText(orig, tps);
            if (text === lastText) return;
            lastText = text;
            target.textContent = text;
        }

        /** 定位（或重新定位）官方速度节点；React 重挂后会自动找回。 */
        function locate() {
            var node = findSpeedNode();
            if (node === null) return;
            if (node !== target) {
                target = node;
                lastText = '';   // 目标变了，允许重写一次
            }
        }

        function tick() {
            try {
                locate();
            } catch (err) {
                console.warn('[dsh-token-speed] 定位失败：', err);
            }
            fetch(API, { cache: 'no-store', credentials: 'same-origin' })
                .then(function (res) { return res.ok ? res.json() : null; })
                .then(function (data) {
                    if (data !== null && data.ok === true && data.active === true && data.tps > 0) {
                        lastTps = data.tps;
                    }
                    // 空闲时沿用上一次的值——用户要求这里不要变空
                    paint(lastTps);
                })
                .catch(function () { paint(lastTps); });
        }

        function apply(ctx) {
            try {
                locate();
                tick();
                pollTimer = setInterval(tick, POLL_MS);

                // React 重渲染会把节点内容改回官方值，这里重新定位并重写（防抖）
                observer = new MutationObserver(function () {
                    if (locateTimer !== null) return;
                    locateTimer = setTimeout(function () {
                        locateTimer = null;
                        try {
                            locate();
                            paint(lastTps);
                        } catch (err) { /* 忽略 */ }
                    }, 120);
                });
                observer.observe(document.body, { childList: true, subtree: true, characterData: true });
            } catch (err) {
                console.warn('[dsh-token-speed] 装配失败：', err);
            }

            ctx.effect(function () {
                return function () {
                    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
                    if (locateTimer !== null) { clearTimeout(locateTimer); locateTimer = null; }
                    if (observer !== null) { observer.disconnect(); observer = null; }
                    // 还原官方原文，把借来的位置还回去
                    if (target !== null) {
                        var orig = target.getAttribute(ORIG_ATTR);
                        if (orig !== null) {
                            target.textContent = orig;
                            target.removeAttribute(ORIG_ATTR);
                        }
                    }
                    target = null;
                    lastText = '';
                };
            }, 'dsh-token-speed: 状态栏实时速度');
        }

        exports.apply = apply;
        return module.exports;
    },
});
