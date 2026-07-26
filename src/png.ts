import * as zlib from 'zlib';

/**
 * Minimal PNG decoder, just enough to read pixels back out of a CDP
 * screenshot.
 *
 * Why this exists: a WebGL canvas created without `preserveDrawingBuffer`
 * has its drawing buffer cleared once the frame is composited, so in-page
 * readback (`toDataURL`, `drawImage`, a late `readPixels`) returns solid
 * black no matter what is on screen. `Page.captureScreenshot` captures the
 * *composited* output instead, so it sees the real thing — but it hands back
 * a PNG, and an agent wanting to assert "this swatch is #3366ff" needs a
 * number, not an image it has to look at.
 *
 * Scope is deliberately narrow: 8-bit, non-interlaced, RGB or RGBA — which is
 * what Chromium emits for screenshots. Anything else throws rather than
 * guessing.
 */

export interface DecodedImage {
	width: number;
	height: number;
	/** 3 for RGB, 4 for RGBA. */
	channels: number;
	/** Un-filtered pixel data, `width * height * channels` bytes. */
	data: Buffer;
}

export interface Pixel {
	r: number;
	g: number;
	b: number;
	a: number;
	/** `#rrggbb`, the form a caller can compare against CSS. */
	hex: string;
}

const PNG_SIGNATURE = 0x89504e47;

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}

/** Reverse the per-scanline filter PNG applies before compression. */
function unfilter(type: number, cur: Buffer, prev: Buffer, bpp: number): void {
	switch (type) {
		case 0: // None
			break;
		case 1: // Sub
			for (let i = bpp; i < cur.length; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff;
			break;
		case 2: // Up
			for (let i = 0; i < cur.length; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
			break;
		case 3: // Average
			for (let i = 0; i < cur.length; i++) {
				const left = i >= bpp ? cur[i - bpp] : 0;
				cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 0xff;
			}
			break;
		case 4: // Paeth
			for (let i = 0; i < cur.length; i++) {
				const left = i >= bpp ? cur[i - bpp] : 0;
				const upLeft = i >= bpp ? prev[i - bpp] : 0;
				cur[i] = (cur[i] + paeth(left, prev[i], upLeft)) & 0xff;
			}
			break;
		default:
			throw new Error(`Unsupported PNG filter type ${type}`);
	}
}

export function decodePng(buffer: Buffer): DecodedImage {
	if (buffer.length < 8 || buffer.readUInt32BE(0) !== PNG_SIGNATURE) {
		throw new Error('Not a PNG');
	}

	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	let interlace = 0;
	const idat: Buffer[] = [];

	// Chunk layout: length(4) type(4) data(length) crc(4)
	let pos = 8;
	while (pos + 8 <= buffer.length) {
		const length = buffer.readUInt32BE(pos);
		const type = buffer.toString('ascii', pos + 4, pos + 8);
		const data = buffer.subarray(pos + 8, pos + 8 + length);
		pos += 12 + length;

		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8];
			colorType = data[9];
			interlace = data[12];
		} else if (type === 'IDAT') {
			idat.push(data);
		} else if (type === 'IEND') {
			break;
		}
	}

	if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth} (expected 8)`);
	if (interlace !== 0) throw new Error('Interlaced PNG is not supported');
	const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
	if (!channels) throw new Error(`Unsupported PNG colour type ${colorType} (expected 2 or 6)`);
	if (!idat.length) throw new Error('PNG contains no image data');

	const raw = zlib.inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const out = Buffer.alloc(stride * height);
	let prev = Buffer.alloc(stride);

	for (let y = 0; y < height; y++) {
		const rowStart = y * (stride + 1);
		const filterType = raw[rowStart];
		const row = out.subarray(y * stride, (y + 1) * stride);
		raw.copy(row, 0, rowStart + 1, rowStart + 1 + stride);
		unfilter(filterType, row, prev, channels);
		prev = row;
	}

	return { width, height, channels, data: out };
}

export function pixelAt(image: DecodedImage, x: number, y: number): Pixel {
	const px = Math.max(0, Math.min(image.width - 1, Math.round(x)));
	const py = Math.max(0, Math.min(image.height - 1, Math.round(y)));
	const offset = (py * image.width + px) * image.channels;
	const r = image.data[offset];
	const g = image.data[offset + 1];
	const b = image.data[offset + 2];
	const a = image.channels === 4 ? image.data[offset + 3] : 255;
	const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
	return { r, g, b, a, hex };
}
