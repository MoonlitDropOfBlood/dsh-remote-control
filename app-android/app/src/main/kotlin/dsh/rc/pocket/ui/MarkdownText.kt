/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— markdown 渲染封装（第三方库 com.mikepenz:multiplatform-markdown-renderer-m3）。
 *
 * 为什么单独一层：
 *  - 库 0.35.0 的真实 API 是 `Markdown(content = …, colors = …, typography = …)` /
 *    `Markdown(markdownState = …, …)`，与网上常见的旧签名 `markdown(text = …)` 不同；
 *    **万一签名再变，只改这一个文件**。
 *  - 配色 / 字号全部映射到 DSH 语义 token（Theme.kt），**不在本文件硬编码色值**。
 *
 * 仓库硬规矩：**不自写 markdown 解析**——HarmonyOS 版用 @luvi/lv-markdown-in，
 * Android 端同样用三方库（GFM 解析器 = org.jetbrains:markdown，由该库传递依赖带入）。
 *
 * 流式口径：库的默认路径是**异步解析**（State.Loading → 空 Box），直播时每个增量都会
 * 闪一下空白气泡；这里用 `immediate = true` 同步解析（DSH 消息通常几 KB，代价可忽略），
 * 换取「不闪」。渲染失败（极端畸形输入）→ 退回纯文本，绝不留空白气泡。
 */
package dsh.rc.pocket.ui

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.sp
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.rememberMarkdownState
import dsh.rc.pocket.ui.theme.Fs
import dsh.rc.pocket.ui.theme.PocketTheme

/**
 * markdown 正文渲染（助手气泡 / 思考块展开态）。
 *
 * @param text markdown 原文
 * @param modifier 布局修饰（**必须显式传**：库的默认值是 fillMaxSize，在气泡里会撑爆）
 * @param color 正文颜色（默认取语义 token 的 labelPrimary）
 * @param dim 弱化配色（思考块用，对齐 HarmonyOS 版的独立 markdown 控制器）
 */
@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = PocketTheme.colors.labelPrimary,
    dim: Boolean = false,
) {
    if (text.isEmpty()) return
    val c = PocketTheme.colors
    val body = if (dim) c.labelSecondary else color
    val plain = TextStyle(fontSize = Fs.body, lineHeight = 22.sp, color = body)
    val mono = plain.copy(fontFamily = FontFamily.Monospace, fontSize = Fs.small, lineHeight = 20.sp)
    // immediate = true：同步解析，避免流式时闪空白气泡（见文件头说明）
    val state = rememberMarkdownState(content = text, immediate = true)
    Markdown(
        markdownState = state,
        colors = markdownColor(
            text = body,
            codeBackground = c.bgLayer2,
            inlineCodeBackground = c.bgLayer2,
            dividerColor = c.borderL1,
            tableBackground = c.bgLayer2,
        ),
        typography = markdownTypography(
            h1 = plain.copy(fontSize = Fs.hero, lineHeight = 32.sp, fontWeight = FontWeight.Bold),
            h2 = plain.copy(fontSize = Fs.title, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
            h3 = plain.copy(fontSize = Fs.subtitle, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
            h4 = plain.copy(fontSize = Fs.subtitle, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
            h5 = plain.copy(fontSize = Fs.body, lineHeight = 22.sp, fontWeight = FontWeight.Medium),
            h6 = plain.copy(fontSize = Fs.small, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
            text = plain,
            code = mono,
            inlineCode = mono,
            quote = plain,
            paragraph = plain,
            ordered = plain,
            bullet = plain,
            list = plain,
            link = plain.copy(
                color = c.brandLabel,
                fontWeight = FontWeight.Medium,
                textDecoration = TextDecoration.Underline,
            ),
            table = plain,
        ),
        modifier = modifier,
        // 解析失败 → 纯文本兜底
        error = { m -> Text(text = text, style = plain, modifier = m) },
    )
}
