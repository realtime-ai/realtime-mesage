# Publishing Guide

This guide explains how to publish packages to GitHub Packages.

## Overview

This repository publishes two separate packages:

1. **Server Package** (`@YOUR_USERNAME/realtime-mesage`) - Core server library
2. **SDK Package** (`@YOUR_USERNAME/realtime-mesage-sdk`) - Browser client SDK

Both packages are automatically published to GitHub Packages when you push version tags.

## Prerequisites

- Admin access to the repository
- GitHub Actions enabled
- Packages feature enabled in repository settings

## Publishing the Server Package

### 1. Update Version

Update the version in `package.json`:

```bash
npm version patch  # 1.0.0 -> 1.0.1
npm version minor  # 1.0.1 -> 1.1.0
npm version major  # 1.1.0 -> 2.0.0
```

Or manually edit `package.json`:

```json
{
  "version": "1.2.3"
}
```

### 2. Create and Push Tag

```bash
# Create a version tag
git tag v1.2.3

# Push the tag to trigger GitHub Action
git push origin v1.2.3
```

### 3. Monitor Workflow

Go to **Actions** tab in your GitHub repository and watch the "Publish Server Package" workflow.

The workflow will:
- ✅ Run tests
- ✅ Build the package
- ✅ Publish to GitHub Packages
- ✅ Create a GitHub Release

## Publishing the SDK Package

### 1. Update SDK Version

The SDK version is managed separately. Decide on the version number (e.g., `1.0.0`).

### 2. Create and Push SDK Tag

```bash
# Create an SDK version tag (note the sdk-v prefix)
git tag sdk-v1.0.0

# Push the tag to trigger GitHub Action
git push origin sdk-v1.0.0
```

### 3. Monitor Workflow

Go to **Actions** tab and watch the "Publish SDK Package" workflow.

The workflow will:
- ✅ Run SDK tests
- ✅ Build the SDK
- ✅ Generate `package.json` with the version
- ✅ Publish to GitHub Packages
- ✅ Create a GitHub Release

## Installing Published Packages

### Configure npm to use GitHub Packages

Create or update `.npmrc` in your project:

```bash
@YOUR_USERNAME:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

**Generate a GitHub Token:**
1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Select scopes: `read:packages`
4. Copy the token and add it to `.npmrc`

### Install Server Package

```bash
npm install @YOUR_USERNAME/realtime-mesage@1.2.3
```

**Usage:**

```typescript
import { RealtimeServer, createPresenceModule } from '@YOUR_USERNAME/realtime-mesage';

const server = new RealtimeServer({ io, redis });
server.use(createPresenceModule());
await server.start();
```

### Install SDK Package

```bash
npm install @YOUR_USERNAME/realtime-mesage-sdk@1.0.0
```

**Usage:**

```typescript
import { RealtimeClient } from '@YOUR_USERNAME/realtime-mesage-sdk';

const client = new RealtimeClient({
  baseUrl: 'http://localhost:3000'
});

await client.connect();
const { channel } = await client.joinRoom({
  roomId: 'my-room',
  userId: 'user-1',
  state: { mic: true }
});
```

## Tag Naming Conventions

| Package Type | Tag Format | Example |
|-------------|-----------|---------|
| Server | `v<version>` | `v1.2.3` |
| SDK | `sdk-v<version>` | `sdk-v1.0.0` |

## Troubleshooting

### Workflow Failed to Publish

**Check:**
1. Ensure `GITHUB_TOKEN` has `packages: write` permission (configured in workflow)
2. Verify repository settings allow GitHub Packages
3. Check Action logs for specific error messages

### Cannot Install Package

**Common Issues:**

1. **Authentication Failed**
   - Ensure `.npmrc` has valid GitHub token
   - Token must have `read:packages` scope

2. **Package Not Found**
   - Verify package was published successfully in repository Packages tab
   - Check package name matches scoped name `@YOUR_USERNAME/...`

3. **Version Not Found**
   - Confirm the tag triggered the workflow
   - Check Releases page for published versions

### Update Repository Username

After forking or transferring the repository, update:

1. **`.npmrc`** - Replace `YOUR_USERNAME` with your GitHub username
2. **`package.json`** - Update repository URL
3. **Workflows** - Username is auto-detected from `${{ github.repository }}`

## Manual Publishing (Not Recommended)

If you need to publish manually:

### Server Package

```bash
npm run build
npm publish --registry=https://npm.pkg.github.com
```

### SDK Package

```bash
# Create package.json first (see workflow for template)
npm run build:sdk
cd rtm-sdk
npm publish --registry=https://npm.pkg.github.com
```

**Note:** Manual publishing requires configuring authentication in `~/.npmrc`.

## Semantic Versioning

Follow [Semantic Versioning](https://semver.org/):

- **Major** (X.0.0): Breaking changes
- **Minor** (1.X.0): New features, backward compatible
- **Patch** (1.0.X): Bug fixes, backward compatible

## Release Checklist

Before publishing a new version:

- [ ] Update `CHANGELOG.md` with changes
- [ ] Run full test suite (`npm test`)
- [ ] Update version number
- [ ] Create and push tag
- [ ] Verify GitHub Action succeeds
- [ ] Test installation in a separate project
- [ ] Update documentation if API changed

## CI/CD Integration

### Automated Testing Before Publish

Both workflows run tests before publishing:

**Server Workflow:**
```yaml
- run: npm run test:unit
```

**SDK Workflow:**
```yaml
- run: npm run test:unit -- rtm-sdk/
```

### Publishing from Protected Branches

If you use protected branches, configure branch protection rules to:
1. Require status checks to pass before merging
2. Allow tags to be created by admins only

## Security Best Practices

1. **Never commit tokens** - Use GitHub Actions secrets only
2. **Use scoped tokens** - Limit token permissions to `packages:write`
3. **Enable 2FA** - Protect your GitHub account
4. **Review dependencies** - Run `npm audit` before publishing
5. **Sign commits** - Use GPG signing for release commits

## Support

For issues with publishing:
1. Check [GitHub Packages Documentation](https://docs.github.com/en/packages)
2. Review workflow logs in Actions tab
3. Open an issue in the repository
