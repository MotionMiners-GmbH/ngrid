import { first } from 'rxjs/operators';
import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  Injector,
  ChangeDetectionStrategy,
  ViewChild,
  ViewChildren,
  QueryList,
  AfterContentInit,
  ViewEncapsulation,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ChangeDetectorRef,
  TemplateRef,
  ViewContainerRef,
  EmbeddedViewRef,
  NgZone,
  isDevMode, forwardRef, IterableDiffers, IterableDiffer, DoCheck
} from '@angular/core';

import { coerceBooleanProperty } from '@angular/cdk/coercion';
import { CdkHeaderRowDef, CdkFooterRowDef, CdkRowDef } from '@angular/cdk/table';

import { NegTablePluginController, NegTablePluginContext } from '../ext/plugin-control';
import { NegTablePaginatorKind } from '../paginator';
import { NegCdkVirtualScrollViewportComponent } from './features/virtual-scroll/virtual-scroll-viewport.component';
import { NegDataSource, DataSourceOf, createDS } from '../data-source/index';
import { NegCdkTableComponent } from './neg-cdk-table/neg-cdk-table.component';
import { updateColumnWidths, KillOnDestroy } from './utils';
import { findCellDef } from './directives/cell-def';
import { NegColumnSizeInfo } from './types';
import {
  NegTableCellTemplateContext,
  NegTableMetaCellTemplateContext,
  NegColumn,
  NegColumnStore, NegMetaColumnStore, NegTableColumnSet, NegTableColumnDefinitionSet,
} from './columns';
import { NegTableRegistryService } from './table-registry.service';
import { NegTableConfigService } from './services/config';
import {
  DynamicColumnWidthLogic,
  BoxModelSpaceStrategy,
  DYNAMIC_PADDING_BOX_MODEL_SPACE_STRATEGY,
  DYNAMIC_MARGIN_BOX_MODEL_SPACE_STRATEGY
} from './col-width-logic/dynamic-column-width';

const HIDE_MAIN_HEADER_ROW_STYLE = { height: 0, minHeight: 0, margin: 0, border: 'none', visibility: 'collapse' };

export function pluginControllerFactory(table: { _plugin: NegTablePluginContext; }) {
  return table._plugin.controller;
}

@Component({
  selector: 'neg-table',
  templateUrl: './table.component.html',
  styleUrls: [ './table.component.scss' ],
  host: { // tslint:disable-line:use-host-property-decorator
    '[class.neg-table-empty]': '!dataSource || dataSource.renderLength === 0',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  providers: [
    NegTableRegistryService,
    {
      provide: NegTablePluginController,
      useFactory: pluginControllerFactory,
      deps: [forwardRef(() => NegTableComponent)],
    }
  ]
})
@KillOnDestroy()
export class NegTableComponent<T> implements AfterContentInit, AfterViewInit, DoCheck, OnChanges, OnDestroy {
  readonly self = this;

  /**
   * Set's the margin cell indentation strategy.
   * Margin cell indentation strategy apply margin to cells instead of paddings and defines all cell box-sizing to border-box.
   *
   * When not set (default) the table will use a padding cell indentation strategy.
   * Padding cell indentation strategy apply padding to cells and defines all cell box-sizing to content-box.
   */
  @Input() get boxSpaceModel(): 'padding' | 'margin' { return this._boxSpaceModel; };
  set boxSpaceModel(value: 'padding' | 'margin') {
    if (this._boxSpaceModel !== value) {
      this._boxSpaceModel = value;
      this._cellWidthLogic = value === 'margin'
        ? DYNAMIC_MARGIN_BOX_MODEL_SPACE_STRATEGY
        : DYNAMIC_PADDING_BOX_MODEL_SPACE_STRATEGY
      ;
      if (this.isInit) {
        // The UI changes are applied by toggle the `neg-table-margin-cell-box-model` CSS class.
        // This is managed through binding in `NegCdkTableComponent`.
        // After this change we need to measure the cell's width again so we trigger a resizeRows call.
        // We must run it deferred to allow binding to commit.
        this.ngZone.onStable.pipe(first()).subscribe( () => this.resizeRows(this._store.table.map( c => c.sizeInfo ))  );
      }
    }
  }
  private _boxSpaceModel: 'padding' | 'margin';
  private _cellWidthLogic: BoxModelSpaceStrategy;

  /**
   * Show/Hide the header row.
   * Default: true
   */
  @Input() get showHeader(): boolean { return !this._mainHeaderRowStyle; };
  set showHeader(value: boolean) {
    /* The header row is always rendered, show/hide is implemented through CSS.
       This is required because width alignment is based on the cell's of the header row. */
    value = coerceBooleanProperty(value);
    // we want _mainHeaderRowStyle to exist when value is false and vice versa.
    this._mainHeaderRowStyle = value ? undefined : HIDE_MAIN_HEADER_ROW_STYLE;
  }
  _mainHeaderRowStyle: any;

  /**
   * Show/Hide the footer row.
   * Default: false
   */
  @Input() get showFooter(): boolean { return this._showFooter; };
  set showFooter(value: boolean) {
    // When false, the footer row is not rendered, unlike the header row which is always rendered.
    value = coerceBooleanProperty(value);
    if (this._showFooter !== value) {
      this._showFooter = value;
      this.resetFooterRowDefs();
    }
  }
  _showFooter: boolean;

  /**
   * Set's the behavior of the table when tabbing.
   * The default behavior is none (rows and cells are not focusable)
   *
   * Note that the focus mode has an effect on other functions, for example a detail row will toggle (open/close) using
   * ENTER / SPACE only when focusMode is set to `row`.
   */
  @Input() focusMode: 'row' | 'cell' | 'none' | '' | false | undefined;

  @Input() get dataSourceOf(): DataSourceOf<T> { return this._dataSourceOf }
  set dataSourceOf(value: DataSourceOf<T>) {
    this._dataSourceOf = value
    if (value && !this.dataSource) {
      this.dataSource = createDS<T>().onTrigger( () => this._dataSourceOf || [] ).create();
    }
  }

  @Input() get dataSource(): NegDataSource<T> { return this._dataSource };
  set dataSource(value: NegDataSource<T>) {
    if (this._dataSource !== value) {
      this.setupPaginator();

      // KILL ALL subscriptions for the previous datasource.
      if (this._dataSource) {
        KillOnDestroy.kill(this, this._dataSource);
      }

      const prev = this._dataSource;
      this._dataSource = this._cdkTable.dataSource = value;
      this._plugin.emitEvent({
        kind: 'onDataSource',
        prev,
        curr: value
      });

      if ( value ) {
        if (isDevMode()) {
          value.onError
            .pipe(KillOnDestroy(this, value))
            .subscribe(console.error.bind(console));
        }
        value.onRenderedDataChanged
          .pipe(KillOnDestroy(this, value))
          .subscribe( () => this.setupNoData() )
        // value.pagination = !!this._pagination;
      }
    }
  }

  @Input() get usePagination(): NegTablePaginatorKind | false { return this._pagination; }
  set usePagination(value: NegTablePaginatorKind | false) {
    if ((value as any) === '') {
      value = 'pageNumber';
    }
    if ( value !== this._pagination ) {
      this._pagination = value;
      if (this.dataSource) {
        this.dataSource.pagination = value;
        if (this.dataSource.paginator) {
          this.dataSource.paginator.noCacheMode = this._noCachePaginator;
        }
      }
      this.setupPaginator();
    }
  }
  @Input() get noCachePaginator(): boolean { return this._noCachePaginator; }
  set noCachePaginator(value: boolean) {
    value = coerceBooleanProperty(value);
    if (this._noCachePaginator !== value) {
      this._noCachePaginator = value;
      if (this.dataSource && this.dataSource.paginator) {
        this.dataSource.paginator.noCacheMode = value;
      }
    }
  }

  /**
   * The column definitions for this table.
   */
  @Input() columns: NegTableColumnSet | NegTableColumnDefinitionSet;

  @Input() set hideColumns(value: string[]) {
    this._hideColumns = value;
    this._hideColumnsDirty = true;
  }

  rowFocus: 0 | '' = '';
  cellFocus: 0 | '' = '';

  private _dataSource: NegDataSource<T>;
  private _dataSourceOf: DataSourceOf<T>;

  @ViewChild(NegCdkVirtualScrollViewportComponent) viewport: NegCdkVirtualScrollViewportComponent;
  @ViewChild('beforeContent', { read: ViewContainerRef}) _vcRefBefore: ViewContainerRef;
  @ViewChild('afterContent', { read: ViewContainerRef}) _vcRefAfter: ViewContainerRef;
  @ViewChild('fbTableCell', { read: TemplateRef}) _fbTableCell: TemplateRef<NegTableCellTemplateContext<T>>;
  @ViewChild('fbHeaderCell', { read: TemplateRef}) _fbHeaderCell: TemplateRef<NegTableMetaCellTemplateContext<T>>;
  @ViewChild('fbFooterCell', { read: TemplateRef}) _fbFooterCell: TemplateRef<NegTableMetaCellTemplateContext<T>>;
  @ViewChild(CdkRowDef) _tableRowDef: CdkRowDef<T>;
  @ViewChildren(CdkHeaderRowDef) _headerRowDefs: QueryList<CdkHeaderRowDef>;
  @ViewChildren(CdkFooterRowDef) _footerRowDefs: QueryList<CdkFooterRowDef>;

  /**
   * True when the component is initialized (after AfterViewInit)
   */
  readonly isInit: boolean;

  _cdkTable: NegCdkTableComponent<T>;
  _store: NegColumnStore = new NegColumnStore();
  private _hideColumnsDirty: boolean;
  private _hideColumns: string[];
  private _colHideDiffer: IterableDiffer<string>;
  private _noDateEmbeddedVRef: EmbeddedViewRef<any>;
  private _paginatorEmbeddedVRef: EmbeddedViewRef<any>;
  private _pagination: NegTablePaginatorKind | false;
  private _noCachePaginator = false;
  private _minimumRowWidth: string;

  private _plugin: NegTablePluginContext;

  constructor(injector: Injector,
              vcRef: ViewContainerRef,
              elRef: ElementRef<any>,
              private differs: IterableDiffers,
              private ngZone: NgZone,
              private cdr: ChangeDetectorRef,
              private config: NegTableConfigService,
              public registry: NegTableRegistryService) {
    const tableConfig = config.get('table');
    this.boxSpaceModel = tableConfig.boxSpaceModel;
    this.showHeader = tableConfig.showHeader;
    this.showFooter = tableConfig.showFooter;

    // Create an injector for the extensions/plugins
    // This injector allow plugins (that choose so) to provide a factory function for runtime use.
    // I.E: as if they we're created by angular via template...
    // This allows seamless plugin-to-plugin dependencies without requiring specific template syntax.
    // And also allows auto plugin binding (app wide) without the need for template syntax.
    const pluginInjector = Injector.create({
      providers: [
        { provide: ViewContainerRef, useValue: vcRef },
        { provide: ElementRef, useValue: cdr },
        { provide: ChangeDetectorRef, useValue: elRef },
      ],
      parent: injector,
    });
    this._plugin = new NegTablePluginContext(this, pluginInjector);
  }

  ngDoCheck(): void {
    if (this._hideColumnsDirty) {
      this._hideColumnsDirty = false;
      const value = this._hideColumns;
      if (!this._colHideDiffer && value) {
        try {
          this._colHideDiffer = this.differs.find(value).create();
        } catch (e) {
          throw new Error(`Cannot find a differ supporting object '${value}. hideColumns only supports binding to Iterables such as Arrays.`);
        }
      }
    }
    if (this._colHideDiffer) {
      const hideColumns = this._hideColumns || [];
      const changes = this._colHideDiffer.diff(hideColumns);
      if (changes) {
        this._store.hidden = hideColumns;
        this._minimumRowWidth = '';
        this._cdkTable.syncRows('header');
      }
      if (!this._hideColumns) {
        this._colHideDiffer = undefined;
      }
    }
  }

  ngAfterContentInit(): void {
    // no need to unsubscribe, the reg service is per table instance and it will destroy when this table destroy.
    // Also, at this point initial changes from templates provided in the content are already inside so they will not trigger
    // the order here is very important, because component top of this table will fire life cycle hooks AFTER this component
    // so if we have a top level component registering a template on top it will not show unless we listen.
    this.registry.changes.subscribe( changes => {
      let tableCell = false;
      let headerFooterCell = false;
      for (const c of changes) {
        switch (c.type) {
          case 'tableCell':
            tableCell = true;
            break;
          case 'headerCell':
          case 'footerCell':
            headerFooterCell = true;
            break;
          case 'noData':
            this.setupNoData();
            break;
          case 'paginator':
            this.setupPaginator();
            break;
        }
      }
      if (tableCell) {
        this.attachCustomCellTemplates();
      }
      if (headerFooterCell) {
        this.attachCustomHeaderCellTemplates();
      }
    });
  }

  ngAfterViewInit(): void {
    this.invalidateHeader();

    // after invalidating the headers we now have optional header/headerGroups/footer rows added
    // we need to update the template with this data which will create new rows (header/footer)
    this.resetHeaderRowDefs();
    this.resetFooterRowDefs();

    Object.defineProperty(this, 'isInit', { value: true });
    this._plugin.emitEvent({ kind: 'onInit' });

    this.setupPaginator();
    if (this.viewport.enabled) {
      this._cdkTable.attachViewPort(this.viewport);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    let processColumns = false;

    if (changes.focusMode) {
      this.rowFocus = this.focusMode === 'row' ? 0 : '';
      this.cellFocus = this.focusMode === 'cell' ? 0 : '';
    }

    if ( changes.columns && this.isInit ) {
      processColumns = true;
    }

    if ( processColumns === true ) {
      this.invalidateHeader();
      this._cdkTable.syncRows();
    }
  }

  ngOnDestroy(): void {
    this._plugin.destroy();
    if (this.viewport) {
      this._cdkTable.detachViewPort();
    }
  }

  trackBy(index: number, item: T): any {
    return item;
  }

  /**
   * Invalidates the header, including a full rebuild of column headers
   */
  invalidateHeader(): void {
    this._store.invalidate(this.columns);
    this.attachCustomCellTemplates();
    this.attachCustomHeaderCellTemplates();
    this.cdr.markForCheck();
    this.cdr.detectChanges();
    this.resetHeaderRowDefs();
    this.resetFooterRowDefs();
    this._plugin.emitEvent({ kind: 'onInvalidateHeaders' });
  }

  resizeRows(data: NegColumnSizeInfo[]): void {
    // stores and calculates width for columns added to it. Aggregate's the total width of all added columns.
    const rowWidth = new DynamicColumnWidthLogic(this._cellWidthLogic);

    // From all meta columns (header/footer/headerGroup) we filter only `headerGroup` columns.
    // For each we calculate it's width from all of the columns that the headerGroup "groups".
    // We use the same strategy and the same RowWidthDynamicAggregator instance which will prevent duplicate calculations.
    // Note that we might have multiple header groups, i.e. same columns on multiple groups with different row index.
    for (const m of this._store.meta) {
      const g = m.headerGroup;
      if (g) {
        if (g.isVisible) {
          const cols = data.filter( d => !d.column.hidden && d.column.isInGroup(g) );
          const groupWidth = rowWidth.addGroup(cols);
          g.updateWidth(`${groupWidth}px`);
        } else {
          g.updateWidth(`0px`);
        }
        g.columnDef.markForCheck();
      }
    }

    // if this is a table without groups
    if (rowWidth.minimumRowWidth === 0) {
      rowWidth.addGroup(data);
    }

    // if the max lock state has changed we need to update re-calculate the static width's again.
    if (rowWidth.maxWidthLockChanged) {
       updateColumnWidths(this._store.getStaticWidth(), this._store.table, this._store.meta);
       data.forEach( d => d.column.columnDef.markForCheck() );
       this.resizeRows(data);
       return;
    }

    if (!this._minimumRowWidth ) {
      // We calculate the total minimum width of the table
      // We do it once, to set the minimum width based on the initial setup.
      // Note that we don't apply strategy here, we want the entire length of the table!
      this._cdkTable.minWidth = `${rowWidth.minimumRowWidth}px`;
    }

    this.ngZone.run( () => {
      this._cdkTable.syncRows('header');
      this._plugin.emitEvent({ kind: 'onResizeRow' });
    });
  }

  /**
   * Create an embedded view before or after the user projected content.
   */
  createView<C>(location: 'before' | 'after', templateRef: TemplateRef<C>, context?: C, index?: number): EmbeddedViewRef<C> {
    const vcRef = location === 'before' ? this._vcRefBefore : this._vcRefAfter;
    const view = vcRef.createEmbeddedView(templateRef, context, index);
    view.detectChanges();
    return view;
  }

  /**
   * Remove an already created embedded view.
   * @param view The view to remove
   * @param location The location, if not set defaults to `before`
   * @returns true when a view was removed, false when not. (did not exist in the view container for the provided location)
   */
  removeView(view: EmbeddedViewRef<any>, location?: 'before' | 'after'): boolean {
    const vcRef = location === 'after' ? this._vcRefAfter : this._vcRefBefore;
    const idx = vcRef.indexOf(view);
    if (idx === -1) {
      return false;
    } else {
      vcRef.remove(idx);
      return true;
    }
  }

  private setupNoData(): void {
    if (this._noDateEmbeddedVRef) {
      this.removeView(this._noDateEmbeddedVRef);
      this._noDateEmbeddedVRef = undefined;
    }
    if (this._dataSource && this._dataSource.renderLength === 0) {
      const noDataTemplate = this.registry.getSingle('noData');
      if (noDataTemplate) {
        this._noDateEmbeddedVRef = this.createView('before', noDataTemplate.tRef, { $implicit: this }, 0);
      }
    }
  }

  private setupPaginator(): void {
    if (this.isInit) {
      if (this._paginatorEmbeddedVRef) {
        this.removeView(this._paginatorEmbeddedVRef);
        this._paginatorEmbeddedVRef = undefined;
      }
      if ( this.dataSource && this.usePagination ) {
        const paginatorTemplate = this.registry.getSingle('paginator');
        if (paginatorTemplate) {
          this._paginatorEmbeddedVRef = this.createView('before', paginatorTemplate.tRef, { $implicit: this });
        }
      }
    }
  }

  private attachCustomCellTemplates(): void {
    for (const col of this._store.table) {
      const cell = findCellDef(this.registry, col, 'tableCell', true);
      if ( cell ) {
        col.cellTpl = cell.tRef;
      } else {
        const defaultCellTemplate = this.registry.getMultiDefault('tableCell');
        col.cellTpl = defaultCellTemplate
         ? defaultCellTemplate.tRef
          : this._fbTableCell
        ;
      }
    }
  }

  private attachCustomHeaderCellTemplates(): void {
    const columns: Array<NegColumn | NegMetaColumnStore> = [].concat(this._store.table, this._store.meta);
    const defaultHeaderCellTemplate = this.registry.getMultiDefault('headerCell') || { tRef: this._fbHeaderCell };
    const defaultFooterCellTemplate = this.registry.getMultiDefault('footerCell') || { tRef: this._fbFooterCell };
    for (const col of columns) {
      if (col instanceof NegColumn) {
        const headerCellDef = findCellDef<T>(this.registry, col, 'headerCell', true) || defaultHeaderCellTemplate;
        const footerCellDef = findCellDef<T>(this.registry, col, 'footerCell', true) || defaultFooterCellTemplate;
        col.headerCellTpl = headerCellDef.tRef;
        col.footerCellTpl = footerCellDef.tRef;
      } else {
        if (col.header) {
          const headerCellDef = findCellDef(this.registry, col.header, 'headerCell', true) || defaultHeaderCellTemplate;
          col.header.template = headerCellDef.tRef;
        }
        if (col.headerGroup) {
          const headerCellDef = findCellDef(this.registry, col.headerGroup, 'headerCell', true) || defaultHeaderCellTemplate;
          col.headerGroup.template = headerCellDef.tRef;
        }
        if (col.footer) {
          const footerCellDef = findCellDef(this.registry, col.footer, 'footerCell', true) || defaultFooterCellTemplate;
          col.footer.template = footerCellDef.tRef;
        }
      }
    }
  }

  private resetHeaderRowDefs(): void {
    if (this._headerRowDefs) {
      // The table header (main, with column names) is always the last row def (index 0)
      // Because we want it to show last (after custom headers, group headers...) we first need to pull it and then push.

      this._cdkTable.clearHeaderRowDefs();
      const arr = this._headerRowDefs.toArray();
      arr.push(arr.shift());

      for (const rowDef of arr) {
        this._cdkTable.addHeaderRowDef(rowDef);
      }
    }
  }

  private resetFooterRowDefs(): void {
    if (this._footerRowDefs) {
      this._cdkTable.clearFooterRowDefs();
      const arr = this._footerRowDefs.toArray();
      if (!this.showFooter) {
        arr.shift();
      }
      for (const rowDef of arr) {
        this._cdkTable.addFooterRowDef(rowDef);
      }
    }
  }
}
