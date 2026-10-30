const fs = require("fs");
const path = require("path");

const iconsPath = path.join(__dirname, "icons");

const output = path.join(iconsPath, "icons.json");

const icons = fs.readdirSync(iconsPath)
    .filter(file =>
        /\.(svg|png|jpg|jpeg|webp)$/i.test(file)
    )
    .sort();

fs.writeFileSync(
    output,
    JSON.stringify(icons, null, 2)
);

console.log(`Generated icons.json with ${icons.length} icons`);
