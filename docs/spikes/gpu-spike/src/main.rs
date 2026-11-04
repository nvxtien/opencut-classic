use gpu::GpuContext;

const WIDTH: u32 = 4;
const HEIGHT: u32 = 4;
const BYTES_PER_PIXEL: u32 = 4;

fn main() {
    println!("[spike] requesting GpuContext::new() on native target (no wasm, no canvas)...");
    let ctx = pollster::block_on(GpuContext::new()).expect("GpuContext::new() failed");

    let info = ctx.adapter().get_info();
    println!(
        "[spike] adapter acquired: name={} backend={:?} device_type={:?}",
        info.name, info.backend, info.device_type
    );

    let texture = ctx.create_render_texture(WIDTH, HEIGHT, "spike-texture");
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

    let mut encoder = ctx
        .device()
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("spike-encoder"),
        });

    {
        let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("spike-clear-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: 1.0,
                        g: 0.0,
                        b: 0.0,
                        a: 1.0,
                    }),
                    store: wgpu::StoreOp::Store,
                },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
    }

    let unpadded_bytes_per_row = WIDTH * BYTES_PER_PIXEL;
    let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let padded_bytes_per_row = unpadded_bytes_per_row.div_ceil(align) * align;

    let output_buffer = ctx.device().create_buffer(&wgpu::BufferDescriptor {
        label: Some("spike-readback-buffer"),
        size: (padded_bytes_per_row * HEIGHT) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &output_buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded_bytes_per_row),
                rows_per_image: Some(HEIGHT),
            },
        },
        wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
    );

    ctx.queue().submit(Some(encoder.finish()));

    let buffer_slice = output_buffer.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
        tx.send(result).unwrap();
    });
    ctx.device()
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: None,
        })
        .unwrap();
    rx.recv().unwrap().expect("buffer map failed");

    let data = buffer_slice.get_mapped_range();
    // texture_format() is Bgra8Unorm on non-GL native backends -> bytes are [B, G, R, A]
    let first_pixel = &data[0..4];
    println!(
        "[spike] texture_format={:?} first_pixel_bytes(BGRA order assumed)={:?}",
        ctx.texture_format(),
        first_pixel
    );

    let is_red = first_pixel[2] > 200 && first_pixel[0] < 50 && first_pixel[1] < 50;
    drop(data);
    output_buffer.unmap();

    if is_red {
        println!("[spike] PASS: render-to-texture + readback round-trip produced the cleared red pixel, fully headless, no window/canvas/display involved.");
    } else {
        println!("[spike] FAIL: pixel did not match expected clear color.");
        std::process::exit(1);
    }
}
