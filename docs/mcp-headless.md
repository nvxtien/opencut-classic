# Thiết kế: MCP server + Headless render cho OpenCut

Mục tiêu: agent (Claude, Codex...) tạo và dựng video bằng cách gửi lệnh có cấu trúc
(qua MCP) thay vì click UI, và render ra file video **không cần mở trình duyệt/GUI**
(headless, chạy được trên server).

Quyết định phạm vi (đã chốt):
- Kiến trúc: **server-side thuần** — bóc logic ra khỏi browser, không dựa vào
  Playwright/Chromium để render.
- MVP: **core editing** — tạo project, thêm media vào timeline, cắt/split/trim,
  thêm text cơ bản, export video. Chưa làm caption tự động, sticker, graphic, effect
  nâng cao ở bản đầu.

## 1. Khảo sát hiện trạng (đọc trực tiếp từ code)

| Thành phần | Vị trí | Phụ thuộc browser? | Ghi chú |
|---|---|---|---|
| Project/timeline data model | `apps/web/src/project/types.ts`, `apps/web/src/timeline/types.ts` | Không | Đã là plain data (TS interfaces), gần như JSON-able sẵn |
| Compositor (blend layer, GPU) | `rust/crates/compositor`, `rust/crates/gpu` | **Không** | Dùng `wgpu`. `GpuContext::new()` chỉ cần `web_sys`/canvas khi `cfg(wasm32)`; trên native dùng Metal/Vulkan, render-to-texture, không cần display |
| Effects/masks pipeline | `rust/crates/effects`, `rust/crates/masks` | Không | Thuần Rust, dùng chung `GpuContext` |
| WASM glue hiện tại | `rust/wasm/src/*.rs` | Có (`#![cfg(target_arch = "wasm32")]`) | Chỉ là lớp bind cho browser — không phải engine, có thể viết lớp glue song song cho native |
| Scene orchestration (dựng node tree từ timeline) | `apps/web/src/services/renderer/scene-builder.ts`, `scene-exporter.ts` | Một phần | Logic chọn/tổ chức node là thuần TS; nhưng gọi thẳng `OffscreenCanvas`/`CanvasRenderingContext2D` |
| Vẽ layer (canvas 2D) | `canvas-renderer.ts`, `nodes/text-node.ts`, `nodes/*-node.ts` | **Có** | Dùng `OffscreenCanvas` + `CanvasRenderingContext2D` trực tiếp (translate/scale/rotate/fillText...) |
| Decode/probe media | `apps/web/src/media/mediabunny.ts` | **Có** | Thư viện `mediabunny`, dựa trên WebCodecs API của trình duyệt |
| Audio mixing | `apps/web/src/media/audio.ts`, `audio-mastering.ts` | **Có** | Dùng `AudioContext`/`OfflineAudioContext` (Web Audio API) |
| Export hiện tại | `apps/web/src/export/index.ts` | Có | `downloadBuffer()` dùng `Blob`/`document.createElement("a")` — chỉ là UI download, không phải pipeline render |

Kết luận khảo sát: **lớp tính pixel (GPU compositor) đã headless-ready**; ba lớp
còn chặn headless là **vẽ layer (Canvas2D)**, **decode media (WebCodecs)**, **audio
(Web Audio)** — cả ba đều có giải pháp thay thế server-side đã kiểm chứng rộng rãi
trong ngành (không phải nghiên cứu mới).

## 2. Kiến trúc đề xuất

```
                    ┌─────────────────────┐
  Agent (Claude) ──▶│   MCP server (Node)  │
                    └──────────┬───────────┘
                               │ tool calls (CRUD project JSON)
                               ▼
                    ┌─────────────────────┐
                    │  Project store       │  <- in-memory / file, schema = TProject
                    │  (TS, tái dùng       │
                    │   type có sẵn)       │
                    └──────────┬───────────┘
                               │ export_video(projectId, options)
                               ▼
                    ┌─────────────────────┐
                    │ Headless render job  │
                    │  (Node orchestrator) │
                    └──────────┬───────────┘
            ┌──────────────────┼───────────────────┐
            ▼                  ▼                    ▼
   ┌─────────────────┐ ┌──────────────────┐ ┌──────────────────┐
   │ Media I/O        │ │ Layer compositing │ │ Native compositor │
   │ (ffmpeg: decode   │ │ (@napi-rs/canvas  │ │ crate (gpu/       │
   │ frames + encode   │ │  thay OffscreenC.)│ │ compositor/effects│
   │ audio/video out)  │ │                   │ │ /masks, qua N-API)│
   └─────────────────┘ └──────────────────┘ └──────────────────┘
```

### 2.1 Project store (tái dùng gần như nguyên vẹn)
`TProject` / `TScene` / `TimelineTrack` / phần tử timeline hiện tại đã là data thuần
(không gắn DOM), nên dùng thẳng làm schema — chỉ cần:
- Viết Zod schema song song (validate input từ MCP tool).
- Bỏ các field chỉ dùng cho UI (`timelineViewState`, `thumbnail` dạng blob URL).

### 2.2 Native render engine
Thêm một **binary/crate mới** `rust/crates/headless-render` (hoặc N-API binding
qua `napi-rs`) gọi thẳng `gpu::GpuContext`, `compositor`, `effects`, `masks` —
**không qua wasm-bindgen**, build cho target native (aarch64-apple-darwin trên máy
bạn). Đây là phần rủi ro thấp nhất vì code đã target-agnostic.

### 2.3 Layer compositing (thay Canvas2D)
Dùng **`@napi-rs/canvas`** (Skia native, API tương thích `OffscreenCanvas`/
`CanvasRenderingContext2D`) chạy trong Node — cho phép tái dùng phần lớn
`canvas-renderer.ts` và `nodes/*.ts` gần như nguyên bản (đổi `new OffscreenCanvas()`
→ hàm tạo tương đương của napi-rs/canvas), thay vì viết lại bằng Rust. Đây là lựa
chọn thực dụng: ít rủi ro, tốc độ phát triển nhanh, vẫn 100% không cần trình duyệt.

### 2.4 Media I/O
Thay `mediabunny`/WebCodecs bằng **ffmpeg** (spawn process):
- Decode: `ffmpeg -i input.mp4 -f rawvideo -pix_fmt rgba pipe:1` → đọc frame buffer theo thời điểm cần.
- Encode: ghi raw frame vào `ffmpeg -f rawvideo ... -i pipe:0 output.mp4`.
- Audio: dùng `ffmpeg` filter graph (`amix`, `atrim`, `volume`) thay cho
  `AudioContext`/`OfflineAudioContext` — thay thế trực tiếp, không cần port logic DSP.

### 2.5 MCP server
Package Node mới, dùng `@modelcontextprotocol/sdk`. Tool cho MVP (core editing):

| Tool | Chức năng |
|---|---|
| `create_project` | Tạo project mới (canvas size, fps, background) |
| `list_projects` | Liệt kê project đã lưu trên đĩa (thêm sau khi làm persistence, 2026-11-04) |
| `add_media` | Nạp file video/ảnh/audio vào project (ffmpeg probe lấy metadata) |
| `add_clip` | Thêm clip vào track tại thời điểm cho trước |
| `split_clip` | Cắt clip tại 1 thời điểm (dựa logic `ripple/`, `timeline/creation.ts` có sẵn) |
| `trim_clip` | Chỉnh `trimStart`/`trimEnd` |
| `add_text` | Thêm text element (nội dung, font, vị trí, thời lượng) |
| `remove_element` | Xoá 1 phần tử khỏi track |
| `get_project_state` | Trả về toàn bộ `TProject` hiện tại (JSON) |
| `delete_project` | Xoá project khỏi in-memory store (thêm sau khi dùng thử thật, 2026-11-04) |
| `export_video` | Khởi chạy render job, trả `jobId` |
| `get_render_status` | Poll trạng thái/progress job, trả path file khi xong |

Edit tool chạy đồng bộ (thao tác data thuần, nhanh). `export_video` chạy job nền
(không block MCP), vì render có thể mất vài giây đến vài phút.

## 3. Rủi ro cần xác thực trước khi build full — Phase 0 (ĐÃ CHẠY, 2026-11-04)

1. **`wgpu` trên macOS thật sự init headless được không** — ✅ **PASS**. Spike:
   binary Rust (`gpu-spike`) gọi `GpuContext::new()` ngoài wasm (path-dep thẳng vào
   `rust/crates/gpu`), tạo render texture, clear màu, copy-to-buffer, map, đọc lại
   pixel. Kết quả thật trên máy:
   ```
   [spike] adapter acquired: name=Apple M1 backend=Metal device_type=IntegratedGpu
   [spike] texture_format=Bgra8Unorm first_pixel_bytes(BGRA order assumed)=[0, 0, 255, 255]
   [spike] PASS: render-to-texture + readback round-trip produced the cleared red pixel,
   fully headless, no window/canvas/display involved.
   ```
   Xác nhận: `acquire_device()` native dùng `new_instance_with_webgpu_detection` +
   `InstanceDescriptor::new_without_display_handle()`, request_adapter với
   `compatible_surface: None` — đúng như kỳ vọng, không cần surface/window nào.
   (2 chỗ phải sửa so với code mẫu vì API `wgpu` 29.x đổi: `RenderPassDescriptor`
   cần thêm field `multiview_mask: None`; `device.poll()` nhận
   `PollType::Wait { submission_index: None, timeout: None }` thay vì unit variant.)

2. **`@napi-rs/canvas` tương thích đủ** với các API mà `canvas-renderer.ts`/
   `nodes/*.ts` đang dùng — ✅ **PASS**, 7/7 check: `save/restore/translate/scale/
   rotate`, `fillStyle`/`fillRect`, `globalCompositeOperation` (multiply/screen/
   overlay/lighter), `ctx.filter = "blur(4px)"` (đọc/ghi được), `ctx.roundRect`,
   `ctx.font` + `measureText` (có `actualBoundingBoxAscent/Descent`) + `fillText`,
   và `canvas.toBuffer("image/png")` xuất PNG thật, mở xem đúng pixel (rect bo góc
   màu cam + text "OpenCut headless" render đúng font/vị trí). API bám khá sát
   Canvas2D chuẩn — hầu hết code trong `canvas-renderer.ts`/`nodes/*.ts` tái dùng
   được gần như nguyên bản, chỉ đổi điểm khởi tạo canvas (`new OffscreenCanvas()` →
   `createCanvas()` của napi-rs).

3. **Font loading** — ✅ xác nhận một phần qua spike 2: `GlobalFonts.registerFromPath()`
   nạp được font `.ttf` hệ thống (dùng Arial trong test) và `ctx.font` nhận diện
   đúng family đã đăng ký. Chưa kiểm web font (Google Fonts tải về rồi register) —
   để lúc build thật.

4. **ffmpeg làm nguồn decode có khớp pixel format/timestamp** — xác nhận bước đầu:
   `ffmpeg -f lavfi -i testsrc... -f rawvideo -pix_fmt rgba` xuất đúng
   `width*height*4` byte, đọc lại khớp. Chưa kiểm phần khó hơn (frame timing chính
   xác cho retime/speed ramp, HDR/color space, audio resample) — để lúc build thật
   vì cần project thật để so sánh.

**Kết luận Phase 0: không còn rủi ro kiến trúc.** Cả 2 rủi ro lớn nhất (wgpu headless
native, napi-rs/canvas tương thích) đã pass với bằng chứng chạy thật trên máy, không
phải suy đoán từ tài liệu. Phần còn lại (font web, ffmpeg timing chi tiết) là chi
tiết tích hợp, xử lý được trong quá trình build Phase 1-4 ở mục dưới, không cần
spike riêng.

## 4. Lộ trình triển khai (sau khi Phase 0 pass)

1. ✅ **Project schema + Zod validation — XONG (2026-11-04).** Package
   `packages/project-schema/` (chưa gắn vào bun workspace root, cài/test độc lập
   qua npm `--no-workspaces` để tránh kéo theo toàn bộ cây dependency của
   `apps/web`). Nội dung:
   - `media-time.ts` — `MediaTime` (integer tick, mirror `rust/crates/time`),
     `FrameRate` (`{numerator, denominator}`, mirror
     `rust/crates/time/src/frame_rate.rs`), `CanvasSize`, `Background`.
   - `params.ts` — `ParamValues`, `Effect` (model đầy đủ); `Mask` và
     `ElementAnimations` để **passthrough** (`z.unknown()`) có chủ đích — hai hệ
     thống này (~350 dòng mask geometry, keyframe/bezier animation) ngoài phạm vi
     MVP, không tool nào ghi/đọc chúng; passthrough để `get_project_state` không
     bị schema từ chối khi project có sẵn dữ liệu đó.
   - `timeline.ts` — đủ 7 loại element (`video`, `image`, `text`, `sticker`,
     `graphic`, `effect`, `audio` upload/library) và 5 loại track.
   - `project.ts` — `TProject` đã bỏ `timelineViewState` (editor view state) và
     siết `thumbnail` không còn là `blob:` URL (chỉ hợp lệ trong tab tạo ra nó).
   - Test (`test/round-trip.test.ts`, chạy qua `tsx`, không cần framework test):
     7/7 PASS — parse project hợp lệ, round-trip qua `JSON.stringify`/`parse`
     không mất dữ liệu, reject MediaTime phân số, reject 0 scene, reject track
     type lạ, reject `fps.denominator = 0`, và xác nhận passthrough mask hoạt
     động đúng trên một video element thật.
   - `tsc --noEmit` sạch.
2. ✅ **`headless-render` orchestrator — XONG (2026-11-04).** Package
   `packages/headless-render/`, phụ thuộc `@opencut/project-schema` qua
   `file:../project-schema`. Phát hiện quan trọng khi build: với phạm vi MVP
   (không effect/mask), **native compositor crate (Rust/GPU) không nằm trên
   đường găng** — base compositing (vẽ clip + text) trong code gốc
   (`canvas-renderer.ts`/`nodes/*.ts`) là Canvas2D thuần; GPU/WASM chỉ được
   gọi cho effect passes/mask feather (`gpu-renderer.ts`), ngoài phạm vi MVP.
   Nên Phase 2 MVP chỉ cần napi-rs/canvas + ffmpeg, không cần tích hợp crate
   Rust — để dành việc đó cho giai đoạn effects sau MVP.

   Cấu trúc: `time.ts` (mirror `TICKS_PER_SECOND = 120_000` từ
   `rust/crates/time`) · `scene.ts` (resolve element nào active tại 1 thời
   điểm — main video track + text overlay track) · `decode.ts` (ffmpeg decode
   1 frame nguồn ra PNG, scale đúng canvas size) · `compositor.ts`
   (napi-rs/canvas: fill background → drawImage frame video → fillText
   overlay) · `encode.ts` (1 process ffmpeg sống suốt export, pipe raw RGBA
   từng frame vào stdin, mux h264/mp4) · `render.ts` (vòng lặp frame, orchestrate
   cả chuỗi).

   Test end-to-end thật (không mock): tạo video nguồn bằng
   `ffmpeg testsrc`, dựng project mẫu (1 video clip + 1 text overlay), render
   15 frame → `ffprobe` xác nhận đúng codec h264, đúng kích thước 320×180,
   đúng số frame (15/15). Trích 1 frame giữa ra xem bằng mắt: cả video pattern
   lẫn text overlay đều lên đúng vị trí/nội dung.

   Giới hạn MVP đã biết, ghi lại để không quên: `fps` truyền dạng số thực
   đơn giản (không phải numerator/denominator như `FrameRate`), decode ffmpeg
   chạy 1 process/frame (đúng nhưng chậm, không phù hợp clip dài), chưa có
   audio, chưa fit tỉ lệ khung hình (scale méo thay vì letterbox/crop), text
   style chỉ đọc `content`/`fontSize`/`color`, background `blur` fallback đen.
3. ✅ **MCP server — XONG (2026-11-04).** Package `packages/mcp-server/`, dùng
   `@modelcontextprotocol/sdk` (1.32.2) qua stdio transport. Đủ 10 tool như
   §2.5. Kiến trúc: logic tool là hàm thuần trong `src/tools.ts` (thao tác
   `ProjectStore` in-memory trong `src/store.ts`), tách khỏi phần wire MCP
   trong `src/server.ts` (chỉ đăng ký Zod input schema + gọi hàm) — để test
   được logic mà không cần dựng transport, và test riêng phần giao thức MCP
   thật.

   Quyết định thiết kế: mọi tool nhận/trả thời gian bằng **giây** (số thực),
   không phải `MediaTime` tick — vì đó là cách agent suy luận tự nhiên; quy
   đổi sang tick ở biên tool, dùng lại `mediaTimeFromSeconds`/
   `secondsFromMediaTime` từ `@opencut/headless-render` (không duplicate
   logic lần 3). `add_media` dùng `ffprobe` thật để lấy duration/resolution/
   fps, không tin dữ liệu do caller khai. `export_video` không block — tạo
   `jobId`, chạy render nền (fire-and-forget), `get_render_status` poll kết
   quả.

   Test (2 lớp, không mock):
   - `test/tools.test.ts` — chạy toàn bộ flow MVP qua hàm thuần: create_project
     → add_media (ffprobe thật) → add_clip → split_clip → trim_clip → add_text
     → get_project_state → remove_element (reject id không tồn tại) →
     export_video → poll get_render_status đến "done" → xác nhận file mp4
     thật qua ffprobe. PASS.
   - `test/protocol.test.ts` — spawn `src/server.ts` làm **process con thật**
     qua stdio (giống cách Claude Desktop/Cursor/agent thật sẽ chạy), dùng
     `Client` thật của SDK gọi `tools/list` (xác nhận đủ 10 tool, đúng input
     schema) và `tools/call` (`create_project` thành công; `get_project_state`
     với id sai trả `isError: true` đúng như kỳ vọng). Đây là phần rủi ro mới
     của Phase 3 (wiring SDK, Zod→JSON Schema, stdio transport) — đã xác nhận
     chạy thật qua wire protocol, không chỉ gọi hàm nội bộ. PASS.

4. Test end-to-end: agent tạo 1 project đơn giản (1 clip + 1 text) → export → so
   sánh với video export từ bản web gốc. *(Đã làm phần "agent tạo + export" ở
   bước 3; phần so sánh với bản web gốc — Phase 2 chỉ còn thiếu bản web thật
   để đối chiếu — vẫn ngoài phạm vi đã làm.)*
5. ✅ **Project persistence — XONG (2026-11-04).** Phát sinh từ việc dùng thử
   thật: `ProjectStore` ban đầu chỉ in-memory, project mất khi server restart.
   Thiết kế đã chọn — **lazy-load, write-through, 1 file JSON/project**:
   - Mỗi project lưu riêng `<dataDir>/<projectId>.json`, mặc định
     `~/.opencut-headless/projects` (đổi được qua env
     `OPENCUT_HEADLESS_DATA_DIR`, dùng cho test để không đụng thư mục thật).
   - **Không nạp gì lúc khởi động** — khởi động nhanh như nhau bất kể có bao
     nhiêu project trên đĩa. Project chỉ được đọc từ đĩa lần đầu một tool nào
     đó cần đến `projectId` của nó, rồi cache trong bộ nhớ cho các lần sau
     trong cùng phiên.
   - Mỗi lần sửa project (add_clip, split_clip, trim_clip, add_text,
     remove_element) đều ghi đè lại file ngay (write-through, không debounce).
   - Tool mới: `list_projects` — liệt kê toàn bộ project trên đĩa (id, name,
     duration, updatedAt, mới nhất trước) để agent chọn, không cần biết
     trước `projectId`.
   - `media` và `jobs` (render job) **vẫn chỉ in-memory**, cố ý — ngoài phạm
     vi lần này, ghi rõ trong code: sau khi server restart, `add_media` phải
     gọi lại trước khi export được (mediaId cũ không còn hiệu lực).
   - Mọi hàm trong `tools.ts` chuyển sang `async` theo đó.
   - Test (`tools.test.ts`) mô phỏng **restart thật**: tạo `ProjectStore` thứ
     hai, cùng `dataDir`, cache rỗng — `list_projects`, `get_project_state`,
     `export_video`, `delete_project` đều chạy qua store "mới" này và ra kết
     quả đúng, bao gồm render ra mp4 thật qua `ffprobe` xác nhận. Tổng 3 bộ
     test (tools/protocol/http-protocol) đều PASS, không đụng tới
     `~/.opencut-headless` thật (đã verify thư mục không được tạo ra sau khi
     chạy test).
   - **Rủi ro vận hành đã biết:** thêm 1 server/client khác cùng trỏ vào một
     `dataDir` có thể ghi đè nhau (không có file lock); ngoài phạm vi vì MVP
     giả định 1 agent/1 phiên tại một thời điểm.

6. ✅ **Fix hiệu năng decode — XONG (2026-11-05).** Review hiệu năng đo thật
   trên máy: pipeline gốc (1 process ffmpeg/frame) mất **44ms/frame** (720p).
   Thử nâng cấp lên 1 process decode **sống liên tục** (giống cách `encode.ts`
   đã làm) — hoá ra **chậm hơn hẳn**: đo được **127ms/frame** khi decode và
   encode chạy *song song* cùng lúc trên nội dung thật (dù mỗi process riêng
   lẻ cực nhanh: decode 146ms/120 frame, encode 180ms/120 frame nếu chạy nối
   tiếp). Chưa tìm ra nguyên nhân gốc chính xác (giống kiểu tranh chấp tài
   nguyên giữa 2 process ffmpeg nặng cùng lúc, đặc thù môi trường máy này) —
   thử giới hạn `-threads` cho cả hai không khắc phục được.

   **Fix:** `decode.ts` giờ decode **trọn vẹn 1 element vào RAM trước** (1
   process ffmpeg, `-frames:v N` để không decode dư), đóng hẳn process đó,
   rồi mới bắt đầu feed từng frame cho encoder — không còn 2 process ffmpeg
   nặng chạy chồng lên nhau tại bất kỳ thời điểm nào. Đổi `compositor.ts`
   dùng `ImageData`/`putImageData` thẳng từ buffer RGBA thay vì qua PNG
   trung gian (bớt 1 bước mã hoá/giải mã). Canvas cũng tái sử dụng across
   frame thay vì tạo mới mỗi frame.

   **Kết quả đo lại:** cùng nội dung thật, **2.56ms/frame** — nhanh hơn
   baseline ban đầu **~17 lần**. Export 4s qua đúng MCP tool thật (end-to-end)
   chỉ còn 357ms. Đã verify lại bằng mắt: frame trích ra khớp đúng
   timecode + text overlay như trước khi tối ưu. Toàn bộ test suite cũ
   (tools/protocol/http-protocol/store/overlay-duration/render/encode) đều
   PASS sau khi sửa.

   **Đánh đổi đã biết:** giữ cả 1 element trong RAM (width×height×4×frameCount
   byte) thay vì stream — chấp nhận được ở quy mô clip hiện tại, nhưng sẽ là
   vấn đề thật với clip rất dài (vài chục phút trở lên) ở độ phân giải cao.
   Ngoài phạm vi lần sửa này.

## 7. Ngoài phạm vi MVP (ghi nhận, chưa làm)
- Auto-caption/transcription (`transcription/` module hiện gọi model ASR nào đó
  cần xác minh riêng — có thể chạy server-side dễ dàng vì không phải DOM-bound,
  nhưng chưa khảo sát).
- Sticker/graphic nâng cao, effect phức tạp, GPU-only effect preview.
- Thiết kế ngược (round-trip): mở lại project JSON trong UI web để người dùng
  sửa tay sau khi agent tạo — cần nhưng không chặn MVP.
