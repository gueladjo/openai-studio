import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, '..', 'public', 'icons');

// Ensure icons directory exists
if (!existsSync(iconsDir)) {
  mkdirSync(iconsDir, { recursive: true });
}

const svgPath = join(iconsDir, 'favicon.svg');
const svg = readFileSync(svgPath);

const sizes = [
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 }
];

// Windows reads the taskbar, shortcut, and installer icon from the executable,
// so the desktop build needs a multi-resolution .ico rather than a PNG.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;

// Vista and later accept PNG-compressed entries, so the container is just a
// directory of the PNGs sharp already produces.
const buildIco = (images) => {
  const header = Buffer.alloc(ICO_HEADER_BYTES);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // resource type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(ICO_ENTRY_BYTES * images.length);
  let offset = ICO_HEADER_BYTES + directory.byteLength;

  images.forEach(({ size, data }, index) => {
    const entry = index * ICO_ENTRY_BYTES;
    directory.writeUInt8(size >= 256 ? 0 : size, entry); // 0 encodes 256
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette size (unused for PNG)
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // color planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(data.byteLength, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.byteLength;
  });

  return Buffer.concat([header, directory, ...images.map(({ data }) => data)]);
};

async function generateIcons() {
  console.log('Generating application icons from SVG...');

  for (const { name, size } of sizes) {
    const outputPath = join(iconsDir, name);
    await sharp(svg)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    console.log(`  Created ${name} (${size}x${size})`);
  }

  const icoImages = [];
  for (const size of icoSizes) {
    icoImages.push({
      size,
      data: await sharp(svg).resize(size, size).png().toBuffer()
    });
  }
  const icoPath = join(iconsDir, 'icon.ico');
  writeFileSync(icoPath, buildIco(icoImages));
  console.log(`  Created icon.ico (${icoSizes.join(', ')})`);

  console.log('Done!');
}

generateIcons().catch(console.error);
