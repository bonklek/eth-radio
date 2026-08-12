const themeToggle = document.querySelector('#theme-toggle')

function readTheme() {
  try {
    return localStorage.getItem('rfe-theme')
  } catch {
    return null
  }
}

function saveTheme(value) {
  try {
    localStorage.setItem('rfe-theme', value)
  } catch {
    // Theme preference is optional when storage is unavailable.
  }
}

function renderTheme(isLight) {
  document.body.classList.toggle('light', isLight)
  themeToggle.setAttribute('aria-label', isLight ? 'Switch to dark mode' : 'Switch to light mode')
  themeToggle.setAttribute('title', isLight ? 'Switch to dark mode' : 'Switch to light mode')
  themeToggle.textContent = isLight ? '☼' : '☾'
}

const startsLight = readTheme() === 'light'
renderTheme(startsLight)

themeToggle.addEventListener('click', () => {
  const isLight = !document.body.classList.contains('light')
  renderTheme(isLight)
  saveTheme(isLight ? 'light' : 'dark')
})
