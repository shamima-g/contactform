# AI-First UI Development Template

[![Quality Gates](https://github.com/stadium-software/stadium-8/actions/workflows/quality-gates.yml/badge.svg)](https://github.com/stadium-software/stadium-8/actions/workflows/quality-gates.yml)

A starter template for building web applications by describing what you want in plain language. Claude Code AI agents handle the planning, coding, testing, and quality checks — you focus on _what_ to build, not _how_.

## Getting Started

See the [Getting Started Guide](.template-docs/users/Getting-Started.md) for step-by-step setup instructions.

## How It Works

The workflow runs in three stages — **Intake, Plan, Build**. AI agents handle the planning, writing tests, implementing features, and running quality checks. You describe what you want to build, approve the plan, and verify the result in your browser.

See [Agent Workflow Guide](.template-docs/users/Help/Agent-Workflow-Guide.md) for details.

## Quality Gates

Four quality gates check functionality, security, code quality, and tests — running during the Build stage and on every push. Use `/quality-check` to check the current status.

See [Quality Gates Documentation](.template-docs/users/Help/Quality-Gates.md) for details.

## Template Updates

Pull in improvements from the template at any time with `/upgrade`. It updates the workflow machinery on a branch and applies it once you approve, adds new dependencies without removing yours, and never overwrites your `/web` app code.

See the [Upgrading Guide](.template-docs/users/Help/Upgrading.md), or check [CHANGELOG.md](CHANGELOG.md) for version history.

## Help

See the [Help Center](.template-docs/users/Help/) for reference guides and common issues.
