/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— :core（纯 JVM，**无任何 Android 依赖**）。
 *
 * 为什么要单独一个纯 JVM 模块：协议与加密是硬验收项（契约 §7 KAT 逐字节），
 * 放在纯 JVM 里才能用 `./gradlew :core:test` 在**没有设备/模拟器**的情况下跑：
 *   - KAT 向量（key/iv/ct/tag/HMAC）
 *   - AAD 绑定（换 role / 换 seq / 换 sid 必须解密失败）
 *   - 会话纪元（纪元回退必须拒绝连接）
 *   - 附件分块规划
 *   - 对 e2e/mock-host.mjs 的端到端联调（握手 → 加密业务帧 → 请求-响应）
 */
plugins {
    alias(libs.plugins.kotlin.jvm)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    api(libs.kotlinx.coroutines.core)
    api(libs.kotlinx.serialization.json)
    api(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(kotlin("test"))
}

tasks.withType<Test>().configureEach {
    useJUnit()
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
    }
}
