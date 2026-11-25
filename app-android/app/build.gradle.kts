/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— :app（Android application，Compose UI）。
 */
import java.util.Properties
import java.io.File

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// ---------------------------------------------------------------------------
// 版本号：**构建期从事实源推导**，不再手写常量。
//
// 事实源 = 仓库根 plugin/package.json 的 version（发版流水线强制它与 git 标签一致）。
// 以前这里写死 `versionCode = 3 / versionName = "1.3.4"`，仓库发到 1.3.5 了
// APK 内部还显示 1.3.4 → 设备上装到的 / 应用市场显示的版本永远落后一版
// （release workflow 只校验 relay/plugin 两个 npm 包，不查 App，漏 bump 不会让发版失败）。
//
// 编码：major*1000000 + minor*1000 + patch（与 HarmonyOS app.json5 的 versionCode 同一套）。
// 校验漂移：node tools/sync-app-versions.mjs --check（CI / release 门禁）。
// ---------------------------------------------------------------------------
val repoRoot: File = rootProject.file("..")
val pluginPkg = File(repoRoot, "plugin/package.json")
val appVersion: String = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(pluginPkg.readText())
    ?.groupValues?.get(1)
    ?: error("无法从 ${pluginPkg.path} 读取版本号（事实源缺失）")
val appVersionCode: Int = appVersion.split(".").let { parts ->
    require(parts.size == 3) { "版本号格式非法（期望 major.minor.patch）：$appVersion" }
    parts[0].toInt() * 1000000 + parts[1].toInt() * 1000 + parts[2].toInt()
}

// ---------------------------------------------------------------------------
// 发布签名（密钥与口令**一律不入库**）
//
// 把下列四项写进 app-android/local.properties（已被 .gitignore 忽略）：
//   dshrc.storeFile=<keystore 绝对路径>   例：C:/Users/<you>/.dsh/android/dsh-pocket-release.jks
//   dshrc.storePassword=<keystore 口令>
//   dshrc.keyAlias=<别名>
//   dshrc.keyPassword=<key 口令>
// 也可用同名环境变量（DSHRC_STORE_FILE / DSHRC_STORE_PASSWORD / DSHRC_KEY_ALIAS / DSHRC_KEY_PASSWORD）。
// 缺任一项 → release 构建不签名（仍能出包，只是装不上），**不会让构建失败**。
// ---------------------------------------------------------------------------
val signingProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun signingProp(name: String): String? =
    (signingProps.getProperty(name) ?: System.getenv(name.replace('.', '_').uppercase()))
        ?.trim()
        ?.takeIf { it.isNotEmpty() }

val releaseStoreFile = signingProp("dshrc.storeFile")
val releaseStorePassword = signingProp("dshrc.storePassword")
val releaseKeyAlias = signingProp("dshrc.keyAlias")
val releaseKeyPassword = signingProp("dshrc.keyPassword")
val hasReleaseSigning = listOf(
    releaseStoreFile, releaseStorePassword, releaseKeyAlias, releaseKeyPassword
).all { it != null }

android {
    namespace = "dsh.rc.pocket"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "dsh.rc.pocket"
        minSdk = 26
        targetSdk = 36
        // 版本号由构建期从 plugin/package.json 推导（见文件头「版本号」段），勿写死。
        versionCode = appVersionCode
        versionName = appVersion
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(project(":core"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.zxing.core) // PlanarYUVLuminanceSource 在 core 根包（com.google.zxing）里
    // markdown 渲染（助手消息）：与 HarmonyOS 版用三方库对齐，**禁自写 markdown 解析**
    implementation(libs.markdown)
}
