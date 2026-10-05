/**
 * Turn a title into a URL slug.
 * @param {string} title
 */
export function slugify(title) {
  return title.toLowerCase().replaceAll(" ", "-");
}
