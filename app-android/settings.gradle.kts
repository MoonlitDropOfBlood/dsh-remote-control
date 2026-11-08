/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— Gradle 设置。
 * 契约见仓库根 docs/PROTOCOL.md（v1.2.0，唯一事实源）。
 */
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        // 国内镜像（实测 repo1.maven.org 约 40KB/s，腾讯云约 190KB/s）；保留官方源兜底
        maven("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/")
        mavenCentral()
    }
}

rootProject.name = "dsh-pocket-android"

include(":core")
include(":app")
