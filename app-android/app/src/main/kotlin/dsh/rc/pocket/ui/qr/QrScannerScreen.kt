/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 扫码配对（CameraX + ZXing）。
 *
 * 契约 §3.5：手机端扫码后自动填参连接。
 * 安全口径：**只解析、不执行**——扫到的内容一律交给 [PairUri] 解析，
 * 解析结果只用于回填配对表单，绝不自动连接、绝不执行任何动作。
 *
 * 权限：CAMERA 在运行时申请；用户拒绝时可退回手动输入（连接页提供）。
 */
package dsh.rc.pocket.ui.qr

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.PlanarYUVLuminanceSource
import dsh.rc.pocket.ui.theme.PocketTheme
import dsh.rc.pocket.ui.theme.Radius
import dsh.rc.pocket.ui.theme.Sp
import java.util.concurrent.Executors

/**
 * 扫码页。
 *
 * @param onScanned 扫到内容（**原文**，由调用方交给 [PairUri] 解析）
 * @param onCancel 用户取消 / 选择手动输入
 */
@Composable
fun QrScannerScreen(
    onScanned: (String) -> Unit,
    onCancel: () -> Unit,
) {
    val context = LocalContext.current
    val colors = PocketTheme.colors
    var granted by remember { mutableStateOf(hasCameraPermission(context)) }
    var scanned by remember { mutableStateOf(false) }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { ok -> granted = ok }

    LaunchedEffect(Unit) {
        if (!granted) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.imageViewerBg),
        contentAlignment = Alignment.Center,
    ) {
        if (granted) {
            CameraPreview(onCode = { text ->
                if (!scanned) {
                    scanned = true
                    onScanned(text)
                }
            })
            // 取景框提示
            Box(
                modifier = Modifier.fillMaxWidth(),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "把 DSH 配对二维码放进取景框",
                    color = colors.labelOnBrand,
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .background(colors.scrim, RoundedCornerShape(Radius.pill))
                        .padding(horizontal = Sp.sp3, vertical = Sp.sp2),
                )
            }
        } else {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Sp.sp3),
                modifier = Modifier.padding(Sp.sp5),
            ) {
                Text(
                    text = "需要相机权限才能扫码",
                    color = colors.labelOnBrand,
                    style = MaterialTheme.typography.bodyLarge,
                )
                Text(
                    text = "也可以退回手动输入配对信息",
                    color = colors.labelSecondary,
                    style = MaterialTheme.typography.bodySmall,
                )
                Button(onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) }) {
                    Text("重新申请权限")
                }
            }
        }

        Button(
            onClick = onCancel,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(Sp.sp4),
        ) {
            Text("手动输入")
        }
    }
}

/** 相机权限是否已授予。 */
private fun hasCameraPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

/**
 * 相机预览 + 帧分析。
 *
 * @param onCode 扫到二维码原文时回调（主线程）
 */
@Composable
private fun CameraPreview(onCode: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val mainExecutor = remember(context) { ContextCompat.getMainExecutor(context) }
    val previewView = remember {
        PreviewView(context).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }
    val reader = remember { MultiFormatReader() }

    DisposableEffect(Unit) {
        val executor = Executors.newSingleThreadExecutor()
        val providerFuture = ProcessCameraProvider.getInstance(context)
        val listener = Runnable {
            val provider = runCatching { providerFuture.get() }.getOrNull() ?: return@Runnable
            val preview = Preview.Builder().build()
            preview.setSurfaceProvider(previewView.surfaceProvider)
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(executor) { image ->
                try {
                    val text = decodeQr(image, reader)
                    if (text != null) {
                        mainExecutor.execute { onCode(text) }
                    }
                } catch (e: Exception) {
                    // 单帧解码失败是常态（没扫到 / 运动模糊），继续下一帧
                } finally {
                    image.close()
                }
            }
            runCatching {
                provider.unbindAll()
                provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            }
        }
        providerFuture.addListener(listener, mainExecutor)
        onDispose {
            runCatching { providerFuture.get().unbindAll() }
            executor.shutdown()
        }
    }

    AndroidView(
        factory = { previewView },
        modifier = Modifier.fillMaxSize(),
    )
}

/**
 * 单帧解码：YUV_420_888 的 Y 平面 → ZXing 亮度源 → MultiFormatReader。
 *
 * @return 解码出的文本；没扫到返回 null
 */
private fun decodeQr(image: ImageProxy, reader: MultiFormatReader): String? {
    val luminance = imageProxyToLuminance(image) ?: return null
    val source = PlanarYUVLuminanceSource(
        luminance,
        image.width,
        image.height,
        0,
        0,
        image.width,
        image.height,
        false,
    )
    val bitmap = BinaryBitmap(HybridBinarizer(source))
    return try {
        reader.decodeWithState(bitmap).text
    } catch (e: NotFoundException) {
        null
    } finally {
        reader.reset()
    }
}

/**
 * ImageProxy（YUV_420_888）→ 亮度数组（Y 平面）。
 *
 * 兼容 rowStride ≠ width 与 pixelStride > 1 的设备（逐行拷贝，不假设连续）。
 */
private fun imageProxyToLuminance(image: ImageProxy): ByteArray? {
    if (image.format != android.graphics.ImageFormat.YUV_420_888) return null
    val plane = image.planes.firstOrNull() ?: return null
    val width = image.width
    val height = image.height
    if (width <= 0 || height <= 0) return null
    val out = ByteArray(width * height)
    val buffer = plane.buffer.duplicate()
    val rowStride = plane.rowStride
    val pixelStride = plane.pixelStride
    if (rowStride <= 0 || pixelStride <= 0) return null
    val row = ByteArray(rowStride)
    var outIndex = 0
    for (y in 0 until height) {
        val toRead = minOf(rowStride, buffer.remaining())
        if (toRead <= 0) break
        buffer.get(row, 0, toRead)
        var x = 0
        var i = 0
        while (x < width) {
            out[outIndex++] = if (i < toRead) row[i] else 0
            i += pixelStride
            x++
        }
    }
    return out
}
