/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— :app（Android application，Compose UI）。
 */
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
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
        versionCode = 1
        versionName = "1.3.0"
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
