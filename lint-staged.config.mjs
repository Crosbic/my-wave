const config = {
  '*.ts': ['eslint --fix --no-warn-ignored', 'prettier --write'],
  '*.{js,mjs,cjs,json,md,yml,yaml}': 'prettier --write'
}

export default config
