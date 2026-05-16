import type { DevOutput } from '@/lib/types';

export interface GeneratedProjectValidation {
  status: 'PASS' | 'NEEDS_FIX';
  findings: string[];
  fixInstructions: string;
}

export interface GeneratedProjectValidationContext {
  requirements?: string;
  baOutput?: string;
}

function normalizePath(path: string) {
  return path.replace(/\\/g, '/').toLowerCase();
}

function getFile(output: DevOutput, filePath: string) {
  const normalized = normalizePath(filePath);
  return output.files.find((file) => normalizePath(file.path) === normalized);
}

function getAnyFile(output: DevOutput, filePaths: string[]) {
  for (const filePath of filePaths) {
    const file = getFile(output, filePath);
    if (file) return file;
  }

  return undefined;
}

function hasFile(output: DevOutput, filePath: string) {
  return Boolean(getFile(output, filePath));
}

function hasPathOrDirectory(output: DevOutput, filePath: string) {
  const normalized = normalizePath(filePath).replace(/^\.\/+/, '').replace(/\/+$/, '');
  return output.files.some((file) => {
    const candidate = normalizePath(file.path).replace(/\/+$/, '');
    return candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
}

function hasAnyPath(output: DevOutput, prefix: string) {
  const normalizedPrefix = normalizePath(prefix);
  return output.files.some((file) => normalizePath(file.path).startsWith(normalizedPrefix));
}

function parseJson(content: string): Record<string, any> | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function parseRequirementNames(content: string) {
  return parseRequirementEntries(content).map((entry) => entry.name);
}

function parseRequirementEntries(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, '').trim().toLowerCase())
    .filter(Boolean)
    .map((line) => {
      const name = line.split(/[<>=~!;\s]+/)[0];
      return name ? { name, line } : null;
    })
    .filter((entry): entry is { name: string; line: string } => Boolean(entry));
}

function getPinnedMajorVersion(line: string, packageName: string) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = line.match(new RegExp(`^${escaped}(?:\\[[^\\]]+\\])?\\s*==\\s*(\\d+)\\.`, 'i'));
  return match ? Number.parseInt(match[1], 10) : null;
}

function getPinnedVersion(line: string, packageName: string) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return line.match(new RegExp(`^${escaped}(?:\\[[^\\]]+\\])?\\s*==\\s*([0-9]+(?:\\.[0-9]+){0,2})`, 'i'))?.[1] ?? null;
}

function validatePythonRequirements(requirements: string, findings: string[]) {
  const invalidStdlibRequirements = [
    'sqlite3',
    'json',
    'os',
    'sys',
    'typing',
    'pathlib',
    'datetime',
    'logging',
    'unittest',
    'asyncio',
    're'
  ];

  const entries = parseRequirementEntries(requirements);
  const dependencies = entries.map((entry) => entry.name);
  for (const dependency of dependencies) {
    if (invalidStdlibRequirements.includes(dependency)) {
      findings.push(
        `backend/requirements.txt includes ${dependency}, but ${dependency} is a Python standard-library module and cannot be installed with pip.`
      );
    }
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry.line]));
  const sqlmodel = byName.get('sqlmodel');
  const sqlalchemy = byName.get('sqlalchemy');
  const pydantic = byName.get('pydantic');

  if (sqlmodel) {
    const sqlmodelVersion = getPinnedVersion(sqlmodel, 'sqlmodel');
    const sqlalchemyMajor = sqlalchemy ? getPinnedMajorVersion(sqlalchemy, 'sqlalchemy') : null;
    const pydanticMajor = pydantic ? getPinnedMajorVersion(pydantic, 'pydantic') : null;

    if (sqlmodelVersion === '0.0.8' && sqlalchemyMajor !== null && sqlalchemyMajor >= 2) {
      findings.push('backend/requirements.txt pins sqlmodel==0.0.8 with SQLAlchemy 2.x, but sqlmodel 0.0.8 requires SQLAlchemy <=1.4.41.');
    }

    if (sqlmodelVersion === '0.0.8' && pydanticMajor !== null && pydanticMajor >= 2) {
      findings.push('backend/requirements.txt pins sqlmodel==0.0.8 with Pydantic 2.x, but sqlmodel 0.0.8 requires Pydantic 1.x.');
    }
  }
}

function getAllText(output: DevOutput, context?: GeneratedProjectValidationContext) {
  return [
    context?.requirements ?? '',
    context?.baOutput ?? '',
    output.architecture,
    output.setupInstructions,
    ...output.files.map((file) => `${file.path}\n${file.content}`)
  ].join('\n');
}

function getFrontendCodeFiles(output: DevOutput) {
  return output.files.filter((file) => {
    const normalized = normalizePath(file.path);
    return (
      normalized.startsWith('frontend/') &&
      /\.(js|jsx|ts|tsx)$/.test(normalized) &&
      !/(^|\/)(tailwind|postcss|next)\.config\./.test(normalized)
    );
  });
}

function getBackendPythonFiles(output: DevOutput) {
  return output.files.filter((file) => normalizePath(file.path).startsWith('backend/') && /\.py$/i.test(file.path));
}

function getAllCodeFiles(output: DevOutput) {
  return output.files.filter((file) => /\.(js|jsx|ts|tsx|py)$/i.test(file.path));
}

function hasPermissiveCors(content: string) {
  return (
    /allow_origins\s*=\s*\[\s*["']\*["']\s*\]/i.test(content) ||
    /allow_origin_regex\s*=/.test(content) ||
    /CORS_ALLOW_ALL_ORIGINS\s*=\s*True/i.test(content)
  );
}

function missingCorsOrigins(content: string, origins: string[]) {
  if (hasPermissiveCors(content)) return [];
  return origins.filter((origin) => !content.includes(origin));
}

function frontendUsesBrowserBackendApi(output: DevOutput) {
  return getFrontendCodeFiles(output).some((file) =>
    /NEXT_PUBLIC_API_BASE_URL|fetch\s*\(\s*`\$\{[^}]*api|fetch\s*\(\s*["']https?:\/\/(?:localhost|127\.0\.0\.1|backend)/i.test(file.content)
  );
}

function packageDependencies(packageJson: Record<string, any> | null) {
  return {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {})
  };
}

function findRouteFile(output: DevOutput, patterns: RegExp[]) {
  return output.files.find((file) => {
    const normalized = normalizePath(file.path);
    return patterns.some((pattern) => pattern.test(normalized));
  });
}

function hasGeneratedApiRoute(output: DevOutput, routeName: string) {
  const normalizedRoute = routeName.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
  return output.files.some((file) => {
    const normalized = normalizePath(file.path);
    return (
      normalized.startsWith('frontend/pages/api/') &&
      (normalized.includes(`/${normalizedRoute}.`) || normalized.includes(`/${normalizedRoute}/`))
    );
  });
}

function containsPlaceholder(content: string) {
  return /\b(todo|fixme)\b|add more|lorem ipsum|coming soon|not implemented|mock data only/i.test(content);
}

function routeBlock(content: string, functionName: string) {
  const match = content.match(new RegExp(`def\\s+${functionName}\\s*\\([^)]*\\):[\\s\\S]*?(?=\\n@app\\.|\\ndef\\s+|$)`));
  return match?.[0] ?? '';
}

function getDirectory(filePath: string) {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index + 1) : '';
}

function unquote(value: string) {
  return value.replace(/^["']|["']$/g, '');
}

function parseDockerCopySources(line: string) {
  const trimmed = line.replace(/\s+#.*$/, '').trim();
  const match = trimmed.match(/^(?:COPY|ADD)\s+(.+)$/i);
  if (!match) return [];
  if (/\s--from(?:=|\s)/i.test(trimmed)) return [];

  let body = match[1].trim();
  while (body.startsWith('--')) {
    const parts = body.split(/\s+/);
    parts.shift();
    body = parts.join(' ').trim();
  }

  if (body.startsWith('[')) {
    try {
      const parsed = JSON.parse(body);
      return Array.isArray(parsed) ? parsed.slice(0, -1).filter((item) => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  const tokens = body.match(/"[^"]+"|'[^']+'|\S+/g)?.map(unquote) ?? [];
  return tokens.length > 1 ? tokens.slice(0, -1) : [];
}

function resolveDockerCopySource(dockerfilePath: string, source: string) {
  const normalized = normalizePath(source).replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.startsWith('$') ||
    /^https?:\/\//i.test(normalized) ||
    /[*?[\]{}]/.test(normalized)
  ) {
    return null;
  }

  return `${getDirectory(dockerfilePath)}${normalized}`.replace(/\/+/g, '/');
}

function validateDockerfileReferences(output: DevOutput, findings: string[]) {
  const dockerfiles = output.files.filter((file) => /(^|\/)Dockerfile$/i.test(file.path));

  for (const dockerfile of dockerfiles) {
    for (const line of dockerfile.content.split(/\r?\n/)) {
      for (const source of parseDockerCopySources(line)) {
        const generatedPath = resolveDockerCopySource(dockerfile.path, source);
        if (generatedPath && !hasPathOrDirectory(output, generatedPath)) {
          findings.push(`${dockerfile.path} copies ${source}, but ${generatedPath} is missing from generated files.`);
        }
      }
    }
  }
}

function hasRenderableLocalImageAssets(output: DevOutput) {
  return output.files.some((file) => {
    const normalized = normalizePath(file.path);
    if (normalized.startsWith('frontend/public/images/') && /\.(svg|png|jpe?g|webp|gif)$/i.test(normalized)) {
      return true;
    }

    if (normalized === 'frontend/public/images/products/product-assets.json') {
      const manifest = parseJson(file.content);
      return Array.isArray(manifest?.assets) && manifest.assets.some((asset: any) => typeof asset?.publicPath === 'string');
    }

    return false;
  });
}

function validateRasterAssetPlaceholders(output: DevOutput, findings: string[]) {
  for (const file of output.files) {
    const normalized = normalizePath(file.path);
    if (!/^frontend\/public\/images\/.+\.(png|jpe?g|webp|gif)$/i.test(normalized)) continue;

    if (/^data:image\/svg\+xml/i.test(file.content.trim())) {
      findings.push(
        `${file.path} contains an SVG data URL inside a raster asset file. Rename it to .svg, write decoded <svg> content, and update every /images/* reference to the .svg path.`
      );
      continue;
    }

    findings.push(
      `${file.path} is a raster image path returned as text. Generated files are written as UTF-8 text, so use SVG assets or external/data URLs instead of fake binary image files.`
    );
  }
}

function backendModelsProductSpecifications(output: DevOutput) {
  const backendText = getBackendPythonFiles(output).map((file) => file.content).join('\n');
  if (/specifications?|specs?/i.test(backendText)) return true;

  const commonSpecFields = [
    /movement/i,
    /material/i,
    /water[_\s-]?resistance/i,
    /case[_\s-]?diameter/i,
    /strap/i,
    /power[_\s-]?reserve/i
  ];

  return commonSpecFields.filter((pattern) => pattern.test(backendText)).length >= 3;
}

function validateSqlModelJsonColumns(filePath: string, content: string, findings: string[]) {
  if (!/SQLModel[\s\S]*table\s*=\s*True|table\s*=\s*True[\s\S]*SQLModel/.test(content)) return;

  const listFieldPattern = /^\s+\w+\s*:\s*(?:List|list|Dict|dict)\s*(?:\[|=)/gm;
  const listFields = content.match(listFieldPattern) ?? [];
  if (listFields.length === 0) return;

  const unsafeFields = listFields.filter((fieldLine) => {
    const fieldName = fieldLine.split(':')[0].trim();
    const fieldRegex = new RegExp(`${fieldName}\\s*:[^\\n]+`);
    const line = content.match(fieldRegex)?.[0] ?? fieldLine;
    return !/Column\s*\(\s*JSON|sa_column\s*=\s*Column\s*\(\s*JSON|JSON\s*\)/i.test(line);
  });

  if (unsafeFields.length > 0) {
    findings.push(
      `${filePath} defines SQLModel table fields with List/dict types but no SQLAlchemy JSON columns; use sa_column=Column(JSON) or serialize those fields explicitly.`
    );
  }
}

function getPydanticLikeClassNames(content: string) {
  const classNames = new Set<string>();
  const classPattern = /^class\s+([A-Za-z_]\w*)\s*\(([^)]*)\):/gm;
  let match: RegExpExecArray | null;

  while ((match = classPattern.exec(content))) {
    const [, className, bases] = match;
    if (/SQLModel|BaseModel/.test(bases) && !/table\s*=\s*True/.test(bases)) {
      classNames.add(className);
    }
  }

  return classNames;
}

function getAnnotationModelTypes(annotation: string, modelClassNames: Set<string>) {
  return Array.from(annotation.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g))
    .map((match) => match[0])
    .filter((typeName) => modelClassNames.has(typeName));
}

function validateSqlModelJsonModelValues(filePath: string, content: string, findings: string[]) {
  if (!/SQLModel[\s\S]*table\s*=\s*True|table\s*=\s*True[\s\S]*SQLModel/.test(content)) return;

  const modelClassNames = getPydanticLikeClassNames(content);
  if (modelClassNames.size === 0) return;

  for (const line of content.split(/\r?\n/)) {
    if (!/Field\s*\([\s\S]*Column\s*\(\s*JSON/i.test(line)) continue;

    const field = line.match(/^\s+([A-Za-z_]\w*)\s*:\s*([^=\n]+?)\s*=/);
    if (!field) continue;

    const [, fieldName, annotation] = field;
    const modelTypes = getAnnotationModelTypes(annotation, modelClassNames);
    if (modelTypes.length === 0) continue;

    findings.push(
      `${filePath} stores ${fieldName} in a JSON column but annotates it with ${modelTypes.join(
        '/'
      )}. SQLAlchemy JSON columns must persist plain dict/list values, so use dict/list[dict] fields or serialize model objects before saving.`
    );
  }
}

function hasImmediateSerializationCall(content: string, startIndex: number) {
  const afterCall = content.slice(startIndex, startIndex + 700);
  return /\)\s*\.(?:dict|model_dump)\s*\(/.test(afterCall);
}

function validateSeedJsonModelValues(mainContent: string, seedFiles: Array<{ path: string; content: string }>, findings: string[]) {
  const modelClassNames = getPydanticLikeClassNames(mainContent);
  if (modelClassNames.size === 0) return;

  for (const seedFile of seedFiles) {
    for (const className of Array.from(modelClassNames)) {
      const constructorPattern = new RegExp(`\\b${className}\\s*\\(`, 'g');
      let match: RegExpExecArray | null;
      while ((match = constructorPattern.exec(seedFile.content))) {
        if (!hasImmediateSerializationCall(seedFile.content, match.index)) {
          findings.push(
            `${seedFile.path} creates ${className}(...) objects for seed data without serializing them. JSON-backed fields should use plain dict/list values or ${className}(...).dict()/model_dump().`
          );
          break;
        }
      }
    }
  }
}

export function validateGeneratedProject(output: DevOutput, context?: GeneratedProjectValidationContext): GeneratedProjectValidation {
  const findings: string[] = [];
  const hasFrontend = hasAnyPath(output, 'frontend/') || output.files.some((file) => /next|react/i.test(file.content));
  const hasBackend = hasAnyPath(output, 'backend/') || output.files.some((file) => /fastapi|sqlmodel|uvicorn/i.test(file.content));
  const allText = getAllText(output, context);

  if (hasFrontend) {
    const packageJson = getFile(output, 'frontend/package.json');
    if (!packageJson) {
      findings.push('Frontend appears to be generated but frontend/package.json is missing.');
    } else {
      const parsed = parseJson(packageJson.content);
      const scripts = parsed?.scripts ?? {};
      const dependencies = packageDependencies(parsed);

      if (!scripts.dev || !scripts.build || !scripts.start) {
        findings.push('frontend/package.json must include dev, build, and start scripts.');
      }

      for (const dependency of ['next', 'react', 'react-dom']) {
        if (!dependencies[dependency]) {
          findings.push(`frontend/package.json is missing dependency ${dependency}.`);
        }
      }
    }

    const usesTailwind = output.files.some((file) => /@tailwind|tailwindcss/i.test(file.content));
    if (usesTailwind) {
      if (!hasFile(output, 'frontend/tailwind.config.js') && !hasFile(output, 'frontend/tailwind.config.ts')) {
        findings.push('Frontend uses Tailwind but is missing frontend/tailwind.config.js or frontend/tailwind.config.ts.');
      }

      if (!hasFile(output, 'frontend/postcss.config.js') && !hasFile(output, 'frontend/postcss.config.mjs')) {
        findings.push('Frontend uses Tailwind but is missing frontend/postcss.config.js or frontend/postcss.config.mjs.');
      }

      const packageJson = getFile(output, 'frontend/package.json');
      const dependencies = packageDependencies(packageJson ? parseJson(packageJson.content) : null);
      for (const dependency of ['tailwindcss', 'postcss', 'autoprefixer']) {
        if (!dependencies[dependency]) {
          findings.push(`Frontend uses Tailwind/PostCSS but frontend/package.json is missing dependency ${dependency}.`);
        }
      }
    }

    for (const file of getFrontendCodeFiles(output)) {
      if (/<!--[\s\S]*-->/.test(file.content)) {
        findings.push(`${file.path} contains HTML comment syntax inside JSX, which will fail to compile.`);
      }

      if (containsPlaceholder(file.content)) {
        findings.push(`${file.path} still contains placeholder/TODO content instead of complete implementation.`);
      }
    }

    const globalsImport = output.files.find((file) => /from\s+['"]\.\.\/styles\/globals\.css['"]|import\s+['"]\.\.\/styles\/globals\.css['"]/.test(file.content));
    if (globalsImport && !hasFile(output, 'frontend/styles/globals.css')) {
      findings.push(`${globalsImport.path} imports frontend/styles/globals.css, but that stylesheet is missing.`);
    }

    if (hasBackend) {
      const frontendText = getFrontendCodeFiles(output).map((file) => file.content).join('\n');
      if (/fetch\(\s*['"]\/api\//.test(frontendText) && !hasGeneratedApiRoute(output, 'products')) {
        findings.push('Frontend calls same-origin /api/* routes, but the generated API is a separate backend; use a configurable backend API base URL.');
      }

      const listPage = findRouteFile(output, [/frontend\/pages\/index\.(js|jsx|ts|tsx)$/]);
      if (listPage && /product/i.test(allText) && !/(fetch|axios|getserversideprops|getstaticprops)/i.test(listPage.content)) {
        findings.push('Product list page should fetch products from the generated API instead of rendering only hardcoded product cards.');
      }

      if (listPage && /product/i.test(allText) && !/\.map\s*\(/.test(listPage.content)) {
        findings.push('Product list page should render a product collection, not a single hardcoded card.');
      }

      const detailPage = findRouteFile(output, [/frontend\/pages\/product\/\[[^\]]+\]\.(js|jsx|ts|tsx)$/]);
      if (
        detailPage &&
        !/useRouter|router\.query|getServerSideProps|getStaticProps|getStaticPaths/i.test(detailPage.content)
      ) {
        findings.push('Dynamic product detail page should read the route id with useRouter or Next.js data-fetching params.');
      }

      if (detailPage && /add to cart/i.test(detailPage.content) && !/method\s*:\s*['"]POST['"]|\/api\/cart|addToCart|handleAdd/i.test(detailPage.content)) {
        findings.push('Product detail page includes Add to Cart UI but does not call the cart API.');
      }

      if (/specifications?|attributes?/i.test(allText) && detailPage && !/specifications?|specs?|attributes?/i.test(detailPage.content)) {
        findings.push('Product detail requirements mention specifications/attributes, but the product detail page does not render them.');
      }

      if (detailPage && /Handle 404|if\s*\(\s*!response\.ok\s*\)\s*{\s*(?:\/\/[^\n]*\n)?\s*return\s*;/i.test(detailPage.content)) {
        findings.push('Product detail page detects failed product fetches but does not render an error/not-found state.');
      }

      if (/images?|gallery/i.test(allText) && listPage && !/<img|<Image|\bimage\b|\bimageUrl\b|\bimage_url\b/i.test(listPage.content)) {
        findings.push('Product list acceptance criteria mention images, but product cards do not render product images.');
      }
    }
  }

  if (hasBackend) {
    const requirements = getFile(output, 'backend/requirements.txt');
    if (!requirements) {
      findings.push('Backend appears to be FastAPI/Python but backend/requirements.txt is missing.');
    } else {
      validatePythonRequirements(requirements.content, findings);

      for (const dependency of ['fastapi', 'uvicorn']) {
        if (!requirements.content.toLowerCase().includes(dependency)) {
          findings.push(`backend/requirements.txt is missing ${dependency}.`);
        }
      }
    }

    const main = getAnyFile(output, ['backend/app/main.py', 'backend/main.py', 'backend/app.py']);
    if (!main) {
      findings.push('Backend is missing a FastAPI app entrypoint such as backend/main.py or backend/app/main.py.');
    } else if (hasFrontend && frontendUsesBrowserBackendApi(output) && !/CORSMiddleware|allow_origins|allow_origin_regex/i.test(main.content)) {
      findings.push('Backend should configure CORS for browser requests from the generated frontend.');
    } else if (hasFrontend && frontendUsesBrowserBackendApi(output)) {
      const missingOrigins = missingCorsOrigins(main.content, [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:3001',
        'http://127.0.0.1:3001'
      ]);
      if (missingOrigins.length > 0) {
        findings.push(`Backend CORS configuration should allow generated frontend origins: ${missingOrigins.join(', ')}.`);
      }
    } else if (/\.select\(\)/.test(main.content) && /sqlmodel/i.test(main.content)) {
      findings.push('Backend SQLModel queries should use select(Model) instead of Model.select(), which will fail at runtime.');
    } else if (/\bselect\s*\(/.test(main.content) && !/from\s+sqlmodel\s+import\s+[^\n]*\bselect\b/.test(main.content)) {
      findings.push('Backend uses select(...) but does not import select from sqlmodel.');
    }

    if (main) {
      validateSqlModelJsonColumns(main.path, main.content, findings);
      validateSqlModelJsonModelValues(main.path, main.content, findings);

      const productDetailBlock = routeBlock(main.content, 'read_product');
      if (/session\.get\s*\(\s*Product/.test(productDetailBlock) && !/HTTPException|404/.test(productDetailBlock)) {
        findings.push('Product detail API should return a 404 error for an invalid product ID.');
      }

      const cartBlock = routeBlock(main.content, 'add_to_cart');
      if (cartBlock && !/session\.get\s*\(\s*Product|select\s*\(\s*Product|HTTPException|404/.test(cartBlock)) {
        findings.push('Cart API should validate that the product exists before returning success.');
      }

      const frontendPostsJsonToCart = getFrontendCodeFiles(output).some(
        (file) => /\/cart/.test(file.content) && /method\s*:\s*['"]POST['"]/i.test(file.content) && /body\s*:\s*JSON\.stringify/i.test(file.content)
      );
      if (frontendPostsJsonToCart && /def\s+add_to_cart\s*\(\s*product_id\s*:\s*int\s*\)/.test(main.content) && !/Body|BaseModel|SQLModel[^(]*\(/.test(cartBlock)) {
        findings.push('Frontend posts Add to Cart as JSON, but backend add_to_cart expects product_id as a query parameter; align the API contract.');
      }
    }

    const seedFiles = getBackendPythonFiles(output).filter((file) => /(^|\/)seed[-_a-z0-9]*\.py$/i.test(normalizePath(file.path)));
    for (const seedFile of seedFiles) {
      if (/create_engine\s*\(/.test(seedFile.content) && !/from\s+main\s+import\s+[^\n]*\bengine\b/.test(seedFile.content)) {
        findings.push(`${seedFile.path} creates its own database engine; seed scripts must use the same engine/DATABASE_URL as the backend app.`);
      }

      if (
        /Session\s*\(\s*engine\s*\)|session\.(?:exec|add|commit)/i.test(seedFile.content) &&
        /DELETE\s+FROM|session\.add|INSERT\s+INTO/i.test(seedFile.content) &&
        !/metadata\.create_all|create_db_and_tables|run_migrations/i.test(seedFile.content)
      ) {
        findings.push(`${seedFile.path} writes seed data but does not initialize database tables first; call SQLModel.metadata.create_all(engine), run migrations, or call the app's table-init helper before deleting/inserting rows.`);
      }
    }

    if (main) {
      validateSeedJsonModelValues(main.content, seedFiles, findings);
    }

    if (/specifications?/i.test(allText) && !backendModelsProductSpecifications(output)) {
      findings.push('Product detail requirements mention specifications, but backend product data does not model or return specifications.');
    }

    const localImageReferences = getAllCodeFiles(output).some((file) => /\bimage(?:_url)?\s*=\s*["']\/images\/|["']\/images\/[^"']+\.(?:png|jpe?g|webp|gif|svg)["']/i.test(file.content));
    if (localImageReferences && !hasRenderableLocalImageAssets(output)) {
      findings.push('Seed data or frontend code uses /images/* product URLs, but matching renderable frontend/public/images assets are missing.');
    }
  }

  if (hasFrontend && hasBackend && !/8000|api base|api_base|NEXT_PUBLIC_API/i.test(output.setupInstructions)) {
    findings.push('Setup instructions should explain the backend API port and frontend API base URL.');
  }

  const hasSeedData = output.files.some((file) => /(^|\/)seed[-_a-z0-9]*\.(py|js|ts|sql)$/i.test(normalizePath(file.path)));
  if (hasSeedData && !/seed|sample data|initial data/i.test(output.setupInstructions)) {
    findings.push('Setup instructions should explain how seed data is created or when to run the seed script.');
  }

  validateDockerfileReferences(output, findings);
  validateRasterAssetPlaceholders(output, findings);

  return {
    status: findings.length > 0 ? 'NEEDS_FIX' : 'PASS',
    findings,
    fixInstructions:
      findings.length > 0
        ? `Fix these run/build readiness blockers:\n${findings.map((finding) => `- ${finding}`).join('\n')}`
        : ''
  };
}
