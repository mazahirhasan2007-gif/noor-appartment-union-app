# Flat Union Manager

Node.js + Express + SQLite app: flat ke union charges, monthly bills, admin aur resident login.

## Chalane ka tareeqa
1. Node.js (v18 ya upar) install karein: https://nodejs.org
2. Is folder mein terminal kholein aur chalayen:
   ```
   npm install
   npm start
   ```
3. Browser mein kholein: http://localhost:3000

Database file `union.db` pehli dafa chalne par khud ban jati hai.

## Demo login
- Admin: `admin` / `admin123`
- Resident: `A-101` / `1111`  (A-102 / 2222, B-201 / 3333)

Pehle login ke baad Account tab se admin password zaroor badal lein.

## Admins
- Pehla admin (`admin`) **main admin** hai: sirf wohi bills, flats, charges aur payments mein tabdeeli kar sakta hai, aur naye admin bana sakta hai (Admins tab).
- Baqi tamam admins **view-only** hain: sab kuch dekh sakte hain, sirf apna password badal sakte hain.
- Purani `union.db` mein sab se pehla admin khud-ba-khud main admin ban jata hai.

## Folder
- `server.js`  : API (login, flats, charges, bills)
- `db.js`      : SQLite tables aur shuru ka data
- `public/index.html` : poori app ki screens

## Tables
admins, flats, charges, bills, bill_items

## Deploy karte waqt
`JWT_SECRET` environment variable zaroor set karein, masalan: `JWT_SECRET=koi-lamba-random-text npm start`
