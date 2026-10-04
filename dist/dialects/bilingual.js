// src/dialects/bilingual.ts
// ΝΩ-29（跨语系语义盲区修复）：零依赖双语词表桥 —— UI 高频中英映射的单一事实源。
// 背景：semanticHash 的 n-gram 是字符级 —— '整理' 与 'filter' 无任何共享子串，
//   FNV 桶零相交 ⇒ cosine 恒 0；中文意图与英文 UI（真实中文桌面最常见形态）结构性失明。
// 修法：分词后先经本桥把中文 token 归一到英文侧，再进 n-gram —— '整理'→'filter'
//   之后与英文 'filter' 共享全部 n-gram（工单指定：整理→filter）。
// 数据形态约束（test/no29.bilingual.test.ts 执法）：
//   · 键 = 1~3 个 CJK 表意字符（与 uiMemory.tokenize 产出对齐：单字 + 交叠 bigram）；
//   · 值 = 小写 ASCII 词（多词用单空格分隔，如 'address bar'）；
//   · 键唯一、无自映射、反义不互串（移除→remove，添加→add）。
// 三字词还原：uiMemory.tokenize 把 CJK 连续段切成「单字 + 交叠 bigram」，三字词
//   （如 '下一步'）永远不会以整词出现 —— 只会得到相邻交叠对（'下一'+'一步'）。
//   toEnglish 对相邻且尾首相接的 bigram 对做一次还原探测，命中三字键才合并。
// 工程承诺：纯数据 + 纯函数、零依赖、零异常（非数组/非字符串宽收，绝不抛出）、
//   未命中逐 token 原样透传 —— 同语系无命中输入的 embed 输出逐字节不变。
import { CJK_RE } from './tokenizer.js';
/** 中→英 UI 高频词表（[中文键, 英文值] 有序对；键唯一性由测试执法） */
export const BILINGUAL_PAIRS = [
    // ── 动作动词（工单点名集）──────────────────────────────────────────
    ['保存', 'save'], ['另存为', 'save as'], ['打开', 'open'], ['关闭', 'close'],
    ['取消', 'cancel'], ['删除', 'delete'], ['移除', 'remove'], ['编辑', 'edit'],
    ['修改', 'modify'], ['发送', 'send'], ['搜索', 'search'], ['检索', 'search'],
    ['查找', 'find'], ['筛选', 'filter'], ['整理', 'filter'], ['过滤', 'filter'],
    ['排序', 'sort'], ['复制', 'copy'], ['粘贴', 'paste'], ['剪切', 'cut'],
    ['撤销', 'undo'], ['撤回', 'undo'], ['重做', 'redo'], ['恢复', 'restore'],
    ['还原', 'restore'], ['重命名', 'rename'], ['选择', 'select'], ['选中', 'select'],
    ['全选', 'select all'], ['清空', 'clear'], ['清除', 'clear'], ['重置', 'reset'],
    ['应用', 'apply'], ['提交', 'submit'], ['确认', 'confirm'], ['确定', 'ok'],
    ['新建', 'create'], ['创建', 'create'], ['添加', 'add'], ['新增', 'add'],
    ['移动', 'move'], ['拖拽', 'drag'], ['拖动', 'drag'], ['插入', 'insert'],
    ['格式', 'format'], ['打印', 'print'], ['预览', 'preview'], ['分享', 'share'],
    ['导出', 'export'], ['导入', 'import'], ['上传', 'upload'], ['下载', 'download'],
    ['安装', 'install'], ['更新', 'update'], ['升级', 'upgrade'], ['卸载', 'uninstall'],
    ['刷新', 'refresh'], ['重试', 'retry'], ['返回', 'back'], ['退出', 'exit'],
    ['登录', 'login'], ['登入', 'login'], ['登陆', 'login'], ['登出', 'logout'],
    ['注销', 'logout'], ['注册', 'register'], ['点击', 'click'], ['单击', 'click'],
    ['双击', 'double click'], ['右键', 'right click'], ['滚动', 'scroll'],
    ['放大', 'zoom in'], ['缩小', 'zoom out'], ['缩放', 'zoom'], ['旋转', 'rotate'],
    ['裁剪', 'crop'], ['截图', 'screenshot'], ['播放', 'play'], ['暂停', 'pause'],
    ['停止', 'stop'], ['静音', 'mute'], ['快进', 'forward'], ['快退', 'rewind'],
    ['录制', 'record'], ['运行', 'run'], ['执行', 'execute'], ['启动', 'start'],
    ['启用', 'enable'], ['开启', 'enable'], ['禁用', 'disable'], ['停用', 'disable'],
    ['锁定', 'lock'], ['解锁', 'unlock'], ['允许', 'allow'], ['拒绝', 'deny'],
    ['接受', 'accept'], ['同意', 'agree'], ['忽略', 'ignore'], ['跳过', 'skip'],
    ['继续', 'continue'], ['中止', 'abort'], ['完成', 'done'], ['等待', 'wait'],
    ['加载', 'load'], ['载入', 'load'], ['展开', 'expand'], ['折叠', 'collapse'],
    ['收起', 'collapse'], ['隐藏', 'hide'], ['显示', 'show'], ['切换', 'switch'],
    ['检查', 'check'], ['验证', 'verify'], ['授权', 'authorize'], ['加密', 'encrypt'],
    ['压缩', 'compress'], ['解压', 'extract'], ['发布', 'publish'], ['推送', 'push'],
    ['拉取', 'pull'], ['合并', 'merge'], ['克隆', 'clone'], ['归档', 'archive'],
    ['备份', 'backup'], ['同步', 'sync'], ['浏览', 'browse'], ['访问', 'visit'],
    ['回复', 'reply'], ['评论', 'comment'], ['点赞', 'like'], ['关注', 'follow'],
    ['转发', 'forward'], ['举报', 'report'], ['拉黑', 'block'], ['屏蔽', 'block'],
    ['邀请', 'invite'], ['加入', 'join'], ['离开', 'leave'], ['购买', 'buy'],
    ['支付', 'pay'], ['下单', 'order'], ['输入', 'input'], ['输出', 'output'],
    ['替换', 'replace'], ['分组', 'group'], ['最小化', 'minimize'], ['最大化', 'maximize'],
    // ── 界面导航（含三字词）────────────────────────────────────────────
    ['下一步', 'next'], ['上一步', 'previous'], ['下一个', 'next'], ['上一个', 'previous'],
    ['下一页', 'next'], ['上一页', 'previous'], ['后退', 'backward'], ['前进', 'forward'],
    ['主页', 'home'], ['首页', 'home'], ['菜单', 'menu'], ['标签', 'tab'],
    ['标签页', 'tab'], ['页面', 'page'], ['窗口', 'window'], ['视图', 'view'],
    ['查看', 'view'], ['导航', 'navigation'], ['全屏', 'fullscreen'], ['工具', 'tool'],
    ['设置', 'settings'], ['设定', 'settings'], ['配置', 'config'], ['选项', 'option'],
    ['偏好', 'preference'], ['首选项', 'preferences'], ['帮助', 'help'],
    ['反馈', 'feedback'], ['关于', 'about'], ['通用', 'general'], ['基本', 'basic'],
    ['高级', 'advanced'], ['默认', 'default'], ['自定义', 'custom'], ['手动', 'manual'],
    ['自动', 'auto'],
    // ── 账号与安全 ─────────────────────────────────────────────────────
    ['账户', 'account'], ['账号', 'account'], ['用户', 'user'], ['用户名', 'username'],
    ['密码', 'password'], ['邮箱', 'email'], ['邮件', 'mail'], ['头像', 'avatar'],
    ['昵称', 'nickname'], ['个人', 'profile'], ['资料', 'profile'], ['权限', 'permission'],
    ['角色', 'role'], ['管理员', 'admin'], ['安全', 'security'], ['隐私', 'privacy'],
    // ── UI 元素名词（含三字词）──────────────────────────────────────────
    ['按钮', 'button'], ['链接', 'link'], ['图标', 'icon'], ['图片', 'image'],
    ['照片', 'photo'], ['视频', 'video'], ['音频', 'audio'], ['音乐', 'music'],
    ['声音', 'sound'], ['音量', 'volume'], ['表单', 'form'], ['表格', 'table'],
    ['列表', 'list'], ['输入框', 'input'], ['文本框', 'textbox'], ['搜索框', 'searchbox'],
    ['复选框', 'checkbox'], ['单选框', 'radio'], ['下拉', 'dropdown'],
    ['下拉框', 'dropdown'], ['对话框', 'dialog'], ['弹窗', 'popup'], ['提示', 'prompt'],
    ['警告', 'warning'], ['侧栏', 'sidebar'], ['侧边栏', 'sidebar'], ['工具栏', 'toolbar'],
    ['菜单栏', 'menubar'], ['地址', 'address'], ['地址栏', 'address bar'],
    ['任务栏', 'taskbar'], ['导航栏', 'navbar'], ['滚动条', 'scrollbar'],
    ['进度条', 'progress bar'], ['标题', 'title'], ['名称', 'name'], ['字段', 'field'],
    ['内容', 'content'], ['描述', 'description'], ['备注', 'note'], ['消息', 'message'],
    ['通知', 'notification'], ['新闻', 'news'], ['网站', 'website'], ['网页', 'web page'],
    ['历史', 'history'], ['书签', 'bookmark'], ['收藏', 'favorite'], ['光标', 'cursor'],
    ['剪贴板', 'clipboard'], ['回收站', 'trash'], ['组件', 'component'], ['插件', 'plugin'],
    ['扩展', 'extension'], ['页脚', 'footer'], ['栏', 'bar'], ['页', 'page'],
    ['项', 'item'], ['域', 'field'],
    // ── 状态与数据 ─────────────────────────────────────────────────────
    ['错误', 'error'], ['失败', 'fail'], ['成功', 'success'],
    ['进度', 'progress'], ['状态', 'status'], ['模式', 'mode'], ['合计', 'total'],
    ['总数', 'total'], ['数量', 'count'], ['详情', 'detail'], ['细节', 'detail'],
    ['摘要', 'summary'], ['统计', 'statistics'], ['排名', 'rank'], ['分数', 'score'],
    ['等级', 'level'], ['速度', 'speed'], ['质量', 'quality'], ['数据', 'data'],
    ['数据库', 'database'], ['索引', 'index'], ['缓存', 'cache'], ['队列', 'queue'],
    ['堆栈', 'stack'], ['日志', 'log'], ['调试', 'debug'], ['性能', 'performance'],
    ['记录', 'record'], ['图表', 'chart'], ['报告', 'report'], ['报表', 'report'],
    ['单元格', 'cell'], ['工作表', 'sheet'], ['幻灯片', 'slide'], ['段落', 'paragraph'],
    ['公式', 'formula'], ['函数', 'function'], ['变量', 'variable'],
    ['参数', 'parameter'], ['常量', 'constant'], ['循环', 'loop'], ['条件', 'condition'],
    ['逻辑', 'logic'], ['规则', 'rule'], ['模型', 'model'], ['知识', 'knowledge'],
    ['目标', 'goal'], ['计划', 'plan'], ['步骤', 'step'],
    // ── 系统环境 ───────────────────────────────────────────────────────
    ['系统', 'system'], ['软件', 'software'], ['硬件', 'hardware'], ['程序', 'program'],
    ['进程', 'process'], ['线程', 'thread'], ['任务', 'task'], ['桌面', 'desktop'],
    ['屏幕', 'screen'], ['显示器', 'monitor'], ['分辨率', 'resolution'],
    ['亮度', 'brightness'], ['键盘', 'keyboard'], ['鼠标', 'mouse'], ['触摸', 'touch'],
    ['语言', 'language'], ['翻译', 'translate'], ['版本', 'version'], ['服务器', 'server'],
    ['客户端', 'client'], ['浏览器', 'browser'], ['网络', 'network'], ['连接', 'connect'],
    ['断开', 'disconnect'], ['离线', 'offline'], ['在线', 'online'], ['内存', 'memory'],
    ['磁盘', 'disk'], ['存储', 'storage'], ['云端', 'cloud'], ['本地', 'local'],
    ['远程', 'remote'], ['重启', 'reboot'], ['关机', 'shutdown'], ['电源', 'power'],
    ['电池', 'battery'], ['蓝牙', 'bluetooth'], ['无线', 'wireless'], ['快捷键', 'hotkey'],
    ['文件', 'file'], ['文件夹', 'folder'], ['目录', 'directory'], ['文档', 'document'],
    ['文本', 'text'],
    // ── 外观与商务 ─────────────────────────────────────────────────────
    ['主题', 'theme'], ['字体', 'font'], ['颜色', 'color'], ['大小', 'size'],
    ['宽度', 'width'], ['高度', 'height'], ['位置', 'position'], ['对齐', 'align'],
    ['加粗', 'bold'], ['斜体', 'italic'], ['下划线', 'underline'], ['背景', 'background'],
    ['边框', 'border'], ['订单', 'order'], ['购物车', 'cart'], ['商品', 'product'],
    ['价格', 'price'], ['免费', 'free'], ['折扣', 'discount'], ['优惠券', 'coupon'],
    ['付款', 'payment'], ['好友', 'friend'], ['聊天', 'chat'], ['域名', 'domain'],
];
/** 键→值查找表（从 BILINGUAL_PAIRS 构建 —— 重复键会被测试执法揪出） */
export const LOOKUP = new Map(BILINGUAL_PAIRS);
/** 多词值拆分推送（'address bar' → 'address','bar' —— 与英文原生分词粒度对齐） */
function pushMapped(out, value) {
    for (const w of value.split(' '))
        if (w.length > 0)
            out.push(w);
}
/**
 * ΝΩ-29 双语桥：token 序列中的中文 UI 高频词替换为对应英文（未命中原样透传）。
 * · 匹配键统一小写（embed 侧 tokenize 已归一，此处兜底；未命中仍回推原 token）；
 * · 三字词经「相邻交叠 bigram 对」还原（'下一'+'一步' → '下一步' → 'next'），
 *   仅当还原出的三字串恰为词表键才合并 —— 跨段伪交叠不命中即放弃，零误伤；
 * · 纯函数零异常：非数组 ⇒ 空表，非字符串元素 ⇒ 跳过。
 */
export function toEnglish(tokens) {
    if (!Array.isArray(tokens))
        return [];
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (typeof t !== 'string' || t.length === 0)
            continue;
        if (t.length === 2 && CJK_RE.test(t)) {
            const n = tokens[i + 1];
            if (typeof n === 'string' && n.length === 2 && CJK_RE.test(n) &&
                t.charCodeAt(1) === n.charCodeAt(0)) {
                const hit = LOOKUP.get(t + n.charAt(1));
                if (hit !== undefined) {
                    pushMapped(out, hit);
                    i += 1;
                    continue;
                }
            }
        }
        const hit = LOOKUP.get(t.toLowerCase());
        if (hit !== undefined)
            pushMapped(out, hit);
        else
            out.push(t);
    }
    return out;
}
