/**
 * dsh-token-speed — token 速度实时显示（浏览器半边）
 *
 * 在底部统计条里渲染 `N 轮 M 步 · xx tok/s`：
 *   - 轮/步来自 host 的 GET /dsh-tokspeed/api/stats?id=<sessionId>（host 侧读 sessionStats 投影）；
 *   - 速度来自同一条路由里的实时采样（host 半边挂在 llm/stream waterfall 上算的 3 秒滑动窗口）。
 *
 * 为什么不再"就地改写官方那格文本"：
 *   官方 activity 段读的是 `useProjection('sessionStats')`，而这条投影**没进**
 *   客户端可读投影的 schema（那份只有 tokenUsage / contextPressure / contextBreakdown 等，
 *   逐字段 z.object 且不 passthrough，未知键在下发时就被丢掉），浏览器永远拿不到，
 *   于是 `stats.steps` 恒为 0 → 官方那段 `if (stats.steps === 0) return null` 根本不渲染，
 *   没有节点可以改写。所以这里用 `priority: -1` 遮蔽官方那条，自己渲染。
 *
 *   ⚠️ 上游若把 sessionStats 补进客户端投影，删掉下面的 `priority: -1` 即可让位；
 *      或者直接卸载本插件恢复官方行为。
 *
 * 实现要点：
 *   1. list slot 每个 `id` 只渲染最低 priority 的 winner —— 同 id + priority:-1 就是遮蔽。
 *   2. fetch 失败时保留上一次的值，任何情况下都要渲染出内容（遮蔽之后这一段不能变空）。
 *   3. 所有异常就地吞掉：apply 抛错会让 GUI 弹「Failed to load plugins」并中断整个插件。
 */
window.__ModuleLoader__.load({
    id: 'dsh-token-speed',
    factory: function (require) {
        var module = { exports: {} };
        var exports = module.exports;

        var react = require('react');
        var h = react.createElement;

        var API_STATS = '/dsh-tokspeed/api/stats';
        /** 一次请求同时拿回轮/步与实时速度，所以轮询可以稍快。 */
        var POLL_MS = 400;
        var CSS_ID = 'dsh-token-speed/stats.css';

        if (
            typeof document !== 'undefined' &&
            document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null
        ) {
            var styleTag = document.createElement('style');
            styleTag.dataset.plugin = 'dsh-token-speed';
            styleTag.dataset.pluginCss = CSS_ID;
            // 对齐官方 StatsPills 的视觉（同样的主题 token）：13px 一级、圆胶囊、数字等宽。
            styleTag.textContent = [
                '.tokspeed-anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
                '.tokspeed-pill{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
                '.tokspeed-pill svg{flex:none;width:14px;height:14px}',
                '.tokspeed-label{text-overflow:ellipsis;min-width:0;overflow:hidden}'
            ].join('');
            document.head.appendChild(styleTag);
        }

        /** 速度文案：与官方口径一致（>=100 取整，否则一位小数）。 */
        function speedText(tps) {
            if (typeof tps !== 'number' || !isFinite(tps) || tps <= 0) return null;
            var value = tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1);
            return value + ' tok/s';
        }

        /** 与官方 activity 段同款的仪表盘图标（自绘，避免依赖内部图标包）。 */
        function gaugeIcon() {
            return h(
                'svg',
                { viewBox: '0 0 16 16', 'aria-hidden': true },
                h('path', {
                    d: 'M3.2 12.2a5.8 5.8 0 1 1 9.6 0',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '1.5',
                    'stroke-linecap': 'round'
                }),
                h('path', {
                    d: 'M8 12.2 10.6 8',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '1.5',
                    'stroke-linecap': 'round'
                })
            );
        }

        /** 提示过一次就够，别在每次轮询里刷控制台。 */
        var warnedNoSession = false;

        function StatsBar(props) {
            var sessionId = props === null || props === undefined ? undefined : props.sessionId;
            var pair = react.useState(null);
            var data = pair[0];
            var setData = pair[1];
            /** 最后一次有效速度：生成停下后继续显示它，不清空（沿用原插件「保留最后值」的约定）。 */
            var lastTps = react.useRef(0);

            react.useEffect(
                function () {
                    if (typeof sessionId !== 'string' || sessionId === '') {
                        if (!warnedNoSession) {
                            warnedNoSession = true;
                            console.warn('[dsh-token-speed] 未拿到 sessionId，统计条暂时无数据');
                        }
                        return undefined;
                    }
                    var alive = true;
                    var pull = function () {
                        fetch(API_STATS + '?id=' + encodeURIComponent(sessionId), {
                            cache: 'no-store',
                            credentials: 'same-origin'
                        })
                            .then(function (res) {
                                return res.ok ? res.json() : null;
                            })
                            .then(function (payload) {
                                if (!alive || payload === null || payload.ok !== true) return;
                                // 只记住有效的实时值；空闲时 host 报 0，这里保留上一次的读数。
                                if (typeof payload.tps === 'number' && isFinite(payload.tps) && payload.tps > 0) {
                                    lastTps.current = payload.tps;
                                }
                                // 只在前进时覆盖：失败/空响应保留上一次的值，避免闪烁。
                                setData(payload);
                            })
                            .catch(function () {
                                // 网络抖动忽略，保留上一次的值
                            });
                    };
                    pull();
                    var timer = setInterval(pull, POLL_MS);
                    return function () {
                        alive = false;
                        clearInterval(timer);
                    };
                },
                [sessionId]
            );

            var stats = data === null || data === undefined ? null : data.stats;
            var counts =
                stats === null || stats === undefined
                    ? null
                    : stats.turns + ' 轮 ' + stats.steps + ' 步';
            // 没有实时速度时沿用最后一次的值（host 空闲会把 tps 归零，这里不跟着清零）。
            var speed = speedText(lastTps.current);
            // 两样都没有就不占位（与官方那段缺失时的表现一致）；
            // 只有速度时先照官方口径显示速度，等 host 侧统计到位再补上「N 轮 M 步」。
            if (counts === null && speed === null) return null;
            var label =
                counts === null
                    ? speed
                    : speed === null
                      ? counts
                      : counts + ' · ' + speed;

            return h(
                'span',
                {
                    className: 'tokspeed-anchor',
                    'data-composer-stat': 'activity',
                    'data-dsh-tokspeed': 'stats'
                },
                h(
                    'span',
                    { className: 'tokspeed-pill' },
                    gaugeIcon(),
                    h('span', { className: 'tokspeed-label' }, label)
                )
            );
        }

        function apply(ctx) {
            try {
                if (ctx === null || ctx === undefined || ctx.slots === undefined) {
                    console.warn('[dsh-token-speed] 没有 slots 服务，统计条未注册');
                    return;
                }
                ctx.slots.inject('conversation.composer.dock', function () {
                    return ctx.slots.register(
                        {
                            name: 'conversation.composer.dock',
                            id: 'activity', // 与官方同 id
                            order: 0,
                            priority: -1, // 遮蔽官方那条（它因投影取不到值而恒不渲染）
                            inject: function (sessionId) {
                                return { sessionId: sessionId };
                            }
                        },
                        StatsBar
                    );
                });
                console.info('[dsh-token-speed] 统计条已注册（遮蔽官方 activity 段）');
            } catch (error) {
                console.warn('[dsh-token-speed] 统计条注册失败（已忽略）：', error);
            }
        }

        /** 控制台自检入口。 */
        window.__dshTokenSpeed = {
            version: 2,
            api: API_STATS,
            ping: function (sessionId) {
                return fetch(API_STATS + '?id=' + encodeURIComponent(sessionId), {
                    cache: 'no-store',
                    credentials: 'same-origin'
                }).then(function (res) {
                    return res.json();
                });
            }
        };

        exports.apply = apply;
        exports.inject = ['slots'];
        return module.exports;
    }
});
