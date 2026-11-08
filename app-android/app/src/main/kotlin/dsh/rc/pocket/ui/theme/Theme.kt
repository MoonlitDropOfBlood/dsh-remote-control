/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 设计 token（配色 / 间距 / 圆角 / 字号）与主题。
 *
 * 与 HarmonyOS 版 **同源**：
 *  - 色值取自 app/entry/src/main/resources/{base,dark}/element/color.json（同名语义 token）
 *  - 数值层取自 app/entry/src/main/ets/model/theme.ets（SP_ / RADIUS_ / FS_ 三组常量）
 *
 * DSH 家族语义坑（必须遵守）：
 *  - brand_fill 是**填充**色（亮 #4D6BFE / 暗 #6480FF），必须配 label_on_brand（白字）；
 *  - brand_label / border_contrast 是**对比色**，只做描边 / 文字 / 焦点环，
 *    当填充底会出「白底白字」。
 *
 * 全工程**零硬编码色值**：色值只在本文件出现一次，其余代码一律取 LocalPocketColors。
 */
package dsh.rc.pocket.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dsh.rc.core.LinkState
import java.util.Calendar
import java.util.Locale

// ---------------------------------------------------------------------------
// 间距 / 圆角 / 字号阶梯（dp / sp；与 HarmonyOS theme.ets 的 vp / fp 一一对应）
// ---------------------------------------------------------------------------

object Sp {
    val sp1 = 4.dp
    val sp2 = 8.dp
    val sp3 = 12.dp
    val sp4 = 16.dp
    val sp5 = 20.dp
    val sp6 = 24.dp
}

object Radius {
    /** 控件圆角。 */
    val ctrl = 8.dp

    /** 卡片圆角。 */
    val card = 12.dp

    /** 气泡圆角。 */
    val bubble = 14.dp

    /** 胶囊（全圆）。 */
    val pill = 100.dp

    /** 输入面板圆角（比卡片稍圆，输入区是一块软软的面板）。 */
    val composer = 20.dp
}

object Fs {
    val caption = 11.sp
    val small = 12.sp
    val body = 15.sp
    val subtitle = 17.sp
    val title = 20.sp
    val hero = 26.sp
}

/** 1dp 细描边。 */
val Hairline = 1.dp

// ---------------------------------------------------------------------------
// 语义配色
// ---------------------------------------------------------------------------

/**
 * DSH 语义色板（亮 / 暗同名同义）。
 *
 * 字段名与 HarmonyOS color.json 的 token 名一一对应（去掉 app.color. 前缀）。
 */
@Immutable
data class PocketColors(
    val bgBase: Color,
    val bgLayer1: Color,
    val bgLayer2: Color,
    val bgOverlay: Color,
    val bgSidebar: Color,
    val borderL1: Color,
    val borderL2: Color,
    val borderContrast: Color,
    val labelPrimary: Color,
    val labelSecondary: Color,
    val labelTertiary: Color,
    val labelOnBrand: Color,
    val brandFill: Color,
    val brandFillPressed: Color,
    val brandLabel: Color,
    val brandTint: Color,
    val stateError: Color,
    val stateErrorTint: Color,
    val stateWarn: Color,
    val stateWarnTint: Color,
    val stateSuccess: Color,
    val stateSuccessTint: Color,
    val stateIdle: Color,
    val stateIdleTint: Color,
    val fillHover: Color,
    val fillPressed: Color,
    val scrim: Color,
    val imageViewerBg: Color,
)

/** 亮色板（对应 resources/base/element/color.json）。 */
private val LightColors = PocketColors(
    bgBase = Color(0xFFF4F5F7),
    bgLayer1 = Color(0xFFFFFFFF),
    bgLayer2 = Color(0xFFF0F1F4),
    bgOverlay = Color(0xFFFFFFFF),
    bgSidebar = Color(0xFFECEEF2),
    borderL1 = Color(0xFFE4E6EB),
    borderL2 = Color(0xFFC7CBD4),
    borderContrast = Color(0xFF17181C),
    labelPrimary = Color(0xFF17181C),
    labelSecondary = Color(0xFF5F6572),
    labelTertiary = Color(0xFF8A909C),
    labelOnBrand = Color(0xFFFFFFFF),
    brandFill = Color(0xFF4D6BFE),
    brandFillPressed = Color(0xFF3C59E8),
    brandLabel = Color(0xFF3D5AF1),
    brandTint = Color(0x1A4D6BFE),
    stateError = Color(0xFFD6493F),
    stateErrorTint = Color(0x1AD6493F),
    stateWarn = Color(0xFFB4700E),
    stateWarnTint = Color(0x1AB4700E),
    stateSuccess = Color(0xFF1E8E4D),
    stateSuccessTint = Color(0x1A1E8E4D),
    stateIdle = Color(0xFF8A909C),
    stateIdleTint = Color(0x148A909C),
    fillHover = Color(0x0A17181C),
    fillPressed = Color(0x1417181C),
    scrim = Color(0x6617181C),
    imageViewerBg = Color(0xFF000000),
)

/** 暗色板（对应 resources/dark/element/color.json）。 */
private val DarkColors = PocketColors(
    bgBase = Color(0xFF0E0F12),
    bgLayer1 = Color(0xFF17181C),
    bgLayer2 = Color(0xFF1E2025),
    bgOverlay = Color(0xFF23252B),
    bgSidebar = Color(0xFF121317),
    borderL1 = Color(0xFF2A2C33),
    borderL2 = Color(0xFF3D414B),
    borderContrast = Color(0xFFE9EBEF),
    labelPrimary = Color(0xFFE9EBEF),
    labelSecondary = Color(0xFFA2A8B4),
    labelTertiary = Color(0xFF7A8090),
    labelOnBrand = Color(0xFFFFFFFF),
    brandFill = Color(0xFF6480FF),
    brandFillPressed = Color(0xFF5470F0),
    brandLabel = Color(0xFF8FA5FF),
    brandTint = Color(0x266480FF),
    stateError = Color(0xFFFF7A70),
    stateErrorTint = Color(0x26FF7A70),
    stateWarn = Color(0xFFF5A623),
    stateWarnTint = Color(0x26F5A623),
    stateSuccess = Color(0xFF4CC38A),
    stateSuccessTint = Color(0x264CC38A),
    stateIdle = Color(0xFF7A8090),
    stateIdleTint = Color(0x147A8090),
    fillHover = Color(0x14FFFFFF),
    fillPressed = Color(0x1FFFFFFF),
    scrim = Color(0x99000000),
    imageViewerBg = Color(0xFF000000),
)

/** 语义色板（CompositionLocal）：所有 UI 取色只走这里。 */
val LocalPocketColors = staticCompositionLocalOf { LightColors }

/** 取当前语义色板。 */
object PocketTheme {
    val colors: PocketColors
        @Composable
        @ReadOnlyComposable
        get() = LocalPocketColors.current
}

/** Material3 主题：色板由语义 token 派生，保证 M3 内置组件（TextField / Button…）同源。 */
@Composable
fun DshPocketTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val pocket = if (darkTheme) DarkColors else LightColors
    val scheme = if (darkTheme) {
        darkColorScheme(
            primary = pocket.brandFill,
            onPrimary = pocket.labelOnBrand,
            primaryContainer = pocket.brandTint,
            onPrimaryContainer = pocket.brandLabel,
            secondary = pocket.brandLabel,
            onSecondary = pocket.labelOnBrand,
            background = pocket.bgBase,
            onBackground = pocket.labelPrimary,
            surface = pocket.bgBase,
            onSurface = pocket.labelPrimary,
            surfaceVariant = pocket.bgLayer2,
            onSurfaceVariant = pocket.labelSecondary,
            outline = pocket.borderL2,
            outlineVariant = pocket.borderL1,
            error = pocket.stateError,
            onError = pocket.labelOnBrand,
            errorContainer = pocket.stateErrorTint,
            onErrorContainer = pocket.stateError,
            scrim = pocket.scrim,
        )
    } else {
        lightColorScheme(
            primary = pocket.brandFill,
            onPrimary = pocket.labelOnBrand,
            primaryContainer = pocket.brandTint,
            onPrimaryContainer = pocket.brandLabel,
            secondary = pocket.brandLabel,
            onSecondary = pocket.labelOnBrand,
            background = pocket.bgBase,
            onBackground = pocket.labelPrimary,
            surface = pocket.bgBase,
            onSurface = pocket.labelPrimary,
            surfaceVariant = pocket.bgLayer2,
            onSurfaceVariant = pocket.labelSecondary,
            outline = pocket.borderL2,
            outlineVariant = pocket.borderL1,
            error = pocket.stateError,
            onError = pocket.labelOnBrand,
            errorContainer = pocket.stateErrorTint,
            onErrorContainer = pocket.stateError,
            scrim = pocket.scrim,
        )
    }
    val typography = Typography(
        bodyMedium = TextStyle(fontSize = Fs.body, lineHeight = 22.sp, color = pocket.labelPrimary),
        bodySmall = TextStyle(fontSize = Fs.small, lineHeight = 18.sp, color = pocket.labelSecondary),
        labelSmall = TextStyle(fontSize = Fs.caption, lineHeight = 16.sp, color = pocket.labelTertiary),
        titleMedium = TextStyle(fontSize = Fs.subtitle, lineHeight = 24.sp, color = pocket.labelPrimary),
        titleLarge = TextStyle(fontSize = Fs.title, lineHeight = 28.sp, color = pocket.labelPrimary),
    )
    CompositionLocalProvider(LocalPocketColors provides pocket) {
        MaterialTheme(
            colorScheme = scheme,
            typography = typography,
            content = content,
        )
    }
}

// ---------------------------------------------------------------------------
// 链路状态与时间文案（与 HarmonyOS theme.ets 逐条对齐）
// ---------------------------------------------------------------------------

/**
 * 链路状态 → 状态色 token。
 *
 * 取色要读 CompositionLocal（PocketTheme.colors），所以必须是 @Composable。
 */
@Composable
fun linkStateColor(state: LinkState): Color {
    val c = PocketTheme.colors
    return when (state) {
        LinkState.ONLINE -> c.stateSuccess
        LinkState.ERROR -> c.stateError
        LinkState.RECONNECTING -> c.stateWarn
        LinkState.CONNECTING, LinkState.DERIVING, LinkState.HANDSHAKING -> c.brandLabel
        else -> c.stateIdle
    }
}

/** 链路状态 → 中文文案。 */
fun linkStateText(state: LinkState): String = when (state) {
    LinkState.IDLE -> "未连接"
    LinkState.DERIVING -> "派生密钥中"
    LinkState.CONNECTING -> "连接中继中"
    LinkState.HANDSHAKING -> "握手中"
    LinkState.ONLINE -> "已连接"
    LinkState.RECONNECTING -> "重连中"
    LinkState.STOPPED -> "已停止"
    LinkState.ERROR -> "连接错误"
}

/** 链路是否处于「进行中」（连接按钮禁用 / 状态灯呼吸）。 */
fun linkBusy(state: LinkState): Boolean = when (state) {
    LinkState.DERIVING, LinkState.CONNECTING, LinkState.HANDSHAKING, LinkState.RECONNECTING -> true
    else -> false
}

/** 毫秒时间戳 → 相对时间（会话列表「最近活动」）。 */
fun relTime(ts: Long, now: Long = System.currentTimeMillis()): String {
    if (ts <= 0L) return ""
    val diff = now - ts
    return when {
        diff < 60_000L -> "刚刚"
        diff < 3_600_000L -> "${diff / 60_000L} 分钟前"
        diff < 86_400_000L -> "${diff / 3_600_000L} 小时前"
        diff < 7L * 86_400_000L -> "${diff / 86_400_000L} 天前"
        else -> clockDate(ts)
    }
}

/** 两位补零。 */
private fun pad2(n: Int): String = if (n < 10) "0$n" else "$n"

/** 毫秒时间戳 → HH:mm（气泡时间戳）。 */
fun clockTime(ts: Long): String {
    val cal = Calendar.getInstance().apply { timeInMillis = ts }
    return pad2(cal.get(Calendar.HOUR_OF_DAY)) + ":" + pad2(cal.get(Calendar.MINUTE))
}

/** 毫秒时间戳 → YYYY-MM-DD（远期相对时间兜底）。 */
fun clockDate(ts: Long): String {
    val cal = Calendar.getInstance().apply { timeInMillis = ts }
    return String.format(
        Locale.US,
        "%d-%02d-%02d",
        cal.get(Calendar.YEAR),
        cal.get(Calendar.MONTH) + 1,
        cal.get(Calendar.DAY_OF_MONTH),
    )
}

/** 会话 id 截断显示（详情页兜底标题）。 */
fun shortId(id: String): String = if (id.length <= 8) id else id.substring(0, 8) + "…"

/** 毫秒 → 倒计时文案 mm:ss。 */
fun countdownText(msLeft: Long): String {
    val total = if (msLeft > 0L) msLeft / 1000L else 0L
    return pad2((total / 60L).toInt()) + ":" + pad2((total % 60L).toInt())
}
