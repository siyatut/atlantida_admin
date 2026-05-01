# Atlantida Admin Local Setup

This Strapi project runs separately from the React frontend and does not replace WooCommerce yet.

## Local URLs

- Admin panel: `http://localhost:1337/admin`
- API base URL: `http://localhost:1337/api`

On the first visit to `/admin`, Strapi will ask you to create the first administrator account.

## Run locally

```bash
cd /Users/anastasiatyutinova/atlantida_admin
npm run develop
```

## WooCommerce category migration

This project includes a repeatable migration script for importing WooCommerce product categories into the `Subcategory` collection in Strapi.

What it does:

- fetches all WooCommerce categories from `/wp-json/wc/store/v1/products/categories`
- creates missing `Subcategory` records
- updates existing `Subcategory` records by `wooCategoryId`
- links each imported subcategory to an existing `MainCategory` by `externalKey`
- links nested WooCommerce categories through the `parent` relation
- does not create or modify `MainCategory` records
- does not import products

Before running:

- make sure your local Strapi database contains the required `MainCategory` records
- verify the top-level WooCommerce slugs inside `scripts/migrate-woo-categories.js`
- update `MAIN_CATEGORY_MAP` in that script if the WooCommerce store uses different top-level slugs

Run with a store base URL:

```bash
cd /Users/anastasiatyutinova/atlantida_admin
WOO_BASE_URL=https://your-woo-store.example npm run migrate:woo:categories
```

Or run with the full categories endpoint explicitly:

```bash
cd /Users/anastasiatyutinova/atlantida_admin
WOO_CATEGORIES_URL=https://your-woo-store.example/wp-json/wc/store/v1/products/categories npm run migrate:woo:categories
```

What to expect:

- the script is safe to run multiple times
- it logs each category as `created`, `updated`, `skipped`, or `failed`
- it prints a final summary with totals

## Catalog content types

- `Category`
  - `name` (required string)
  - `slug` (required UID)
  - `description` (optional rich text)
  - `wooId` (optional integer)
  - `parent` / `children` self-relation
- `Product`
  - `name` (required string)
  - `slug` (optional UID)
  - `description` (optional rich text)
  - `shortDescription` (optional text)
  - `price` (required decimal)
  - `image` (single image media)
  - `categories` (many-to-many relation)
  - `wooId` (optional integer)
  - `isActive` (boolean, defaults to `true`)

## Local sample data

On first boot, the app seeds:

- 2 categories
- 3 products
- sample SVG images attached through the Strapi upload plugin

The seed runs only when the `Category` and `Product` collections are empty.

## Public read access for local testing

Bootstrap enables public read permissions for:

- `GET /api/categories`
- `GET /api/categories/:documentId`
- `GET /api/products`
- `GET /api/products/:documentId`
- `GET /api/upload/files`
- `GET /api/upload/files/:id`

## Example endpoints

Products with image and category data:

```text
http://localhost:1337/api/products?populate[image][fields][0]=url&populate[image][fields][1]=alternativeText&populate[categories][fields][0]=name&populate[categories][fields][1]=slug
```

Simpler full populate version for quick testing:

```text
http://localhost:1337/api/products?populate=*
```

Categories:

```text
http://localhost:1337/api/categories?sort=name:asc
```

Category tree with parent and children:

```text
http://localhost:1337/api/categories?populate[parent][fields][0]=name&populate[children][fields][0]=name
```

## Current migration stance

- WooCommerce integration in `atlantida_web` is untouched.
- This Strapi app is a separate local backend/admin panel for staged catalog migration.
